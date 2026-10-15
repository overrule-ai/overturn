"""wrap_anthropic: record messages.create (sync/async, streaming or not) as llm_call steps."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Iterator
from datetime import datetime, timezone
from typing import Any, TypeVar, cast

from . import context
from ._json import get_dict, get_int, get_str, is_jsonable
from .pricing import estimate_cost_usd
from .types import Usage

T = TypeVar("T")

_INPUT_KEYS = {"messages", "system", "tools", "tool_choice"}
_SKIP_KEYS = {"model", "stream", *_INPUT_KEYS}


def split_message_params(params: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], str | None]:
    inp = {k: v for k, v in params.items() if k in _INPUT_KEYS}
    rest: dict[str, Any] = {k: v for k, v in params.items() if k not in _SKIP_KEYS and is_jsonable(v)}
    model = params.get("model")
    return inp, rest, model if isinstance(model, str) else None


def _dump(obj: Any) -> dict[str, Any]:
    dump = getattr(obj, "model_dump", None)
    if callable(dump):
        return cast(dict[str, Any], dump(mode="json", exclude_none=True))
    if isinstance(obj, dict):
        return cast(dict[str, Any], obj)
    return {}


def _usage_from(d: dict[str, Any]) -> Usage | None:
    if not isinstance(d.get("usage"), dict):
        return None
    ud = get_dict(d, "usage")
    inp = get_int(ud, "input_tokens")
    out = get_int(ud, "output_tokens")
    return Usage(
        input_tokens=inp,
        output_tokens=out,
        total_tokens=(inp or 0) + (out or 0) if inp is not None or out is not None else None,
        cached_input_tokens=get_int(ud, "cache_read_input_tokens"),
    )


def _record(
    run: Any,
    model: str | None,
    inp: Any,
    params: Any,
    message: Any,
    started: datetime,
    first: float | None,
    error: str | None = None,
) -> None:
    if run is None:
        return
    d = _dump(message) if message is not None else {}
    usage = _usage_from(d) if message is not None else None
    if usage is not None and first is not None:
        usage.first_token_ms = first
    resolved = get_str(d, "model") or model
    output: dict[str, Any] | None = None
    if message is not None:
        output = {
            "message": {"role": get_str(d, "role") or "assistant", "content": d.get("content")},
            "finish_reason": get_str(d, "stop_reason"),
        }
    run.step(
        kind="llm_call",
        name="messages",
        provider="anthropic",
        model=resolved,
        input=inp,
        params=params,
        output=output,
        usage=usage,
        cost_usd=estimate_cost_usd(resolved, usage),
        latency_ms=(datetime.now(timezone.utc) - started).total_seconds() * 1000,
        error=error,
        started_at=started,
    )


def assemble_message_stream(events: list[Any]) -> dict[str, Any]:
    """Rebuilds a Message from raw stream events (message_start, content_block_*, message_delta)."""
    message: dict[str, Any] = {
        "role": "assistant",
        "content": [],
        "model": None,
        "stop_reason": None,
        "usage": {},
    }
    blocks: dict[int, dict[str, Any]] = {}
    json_parts: dict[int, list[str]] = {}
    usage: dict[str, Any] = {}
    for ev in events:
        e = _dump(ev)
        t = get_str(e, "type")
        if t == "message_start":
            m = get_dict(e, "message")
            message["model"] = get_str(m, "model")
            usage.update(get_dict(m, "usage"))
        elif t == "content_block_start":
            idx = get_int(e, "index") or 0
            block = dict(get_dict(e, "content_block"))
            blocks[idx] = block
            if get_str(block, "type") == "tool_use":
                json_parts[idx] = []
                block["input"] = {}
            elif get_str(block, "type") == "text":
                block["text"] = get_str(block, "text") or ""
        elif t == "content_block_delta":
            idx = get_int(e, "index") or 0
            delta = get_dict(e, "delta")
            block = blocks.setdefault(idx, {})
            if get_str(delta, "type") == "text_delta":
                block["text"] = (get_str(block, "text") or "") + (get_str(delta, "text") or "")
            elif get_str(delta, "type") == "input_json_delta":
                json_parts.setdefault(idx, []).append(get_str(delta, "partial_json") or "")
        elif t == "message_delta":
            delta = get_dict(e, "delta")
            if get_str(delta, "stop_reason"):
                message["stop_reason"] = get_str(delta, "stop_reason")
            usage.update({k: v for k, v in get_dict(e, "usage").items() if v is not None})
    message["usage"] = usage
    import json as _json

    for idx, parts in json_parts.items():
        raw = "".join(parts)
        try:
            blocks[idx]["input"] = _json.loads(raw) if raw else {}
        except ValueError:
            blocks[idx]["input"] = {"_raw": raw}
    message["content"] = [blocks[i] for i in sorted(blocks)]
    return message


class _TappedStream:
    def __init__(self, stream: Any, on_done: Any) -> None:
        self._stream = stream
        self._on_done = on_done
        self._events: list[Any] = []
        self._t0 = time.perf_counter()
        self._first: float | None = None

    def __iter__(self) -> Iterator[Any]:
        try:
            for ev in self._stream:
                if self._first is None:
                    self._first = (time.perf_counter() - self._t0) * 1000
                self._events.append(ev)
                yield ev
        finally:
            self._on_done(self._events, self._first)

    def __aiter__(self) -> AsyncIterator[Any]:
        return self._aiter()

    async def _aiter(self) -> AsyncIterator[Any]:
        try:
            async for ev in self._stream:
                if self._first is None:
                    self._first = (time.perf_counter() - self._t0) * 1000
                self._events.append(ev)
                yield ev
        finally:
            self._on_done(self._events, self._first)

    def __getattr__(self, item: str) -> Any:
        return getattr(self._stream, item)


def wrap_anthropic(client: T) -> T:
    """Patches client.messages.create in place (Anthropic and AsyncAnthropic)."""
    messages = cast(Any, client).messages
    original = messages.create
    is_async = type(client).__name__.startswith("Async")

    def on_done_for(run: Any, model: str | None, inp: Any, params: Any, started: datetime) -> Any:
        def on_done(events: list[Any], first: float | None) -> None:
            _record(run, model, inp, params, assemble_message_stream(events), started, first)

        return on_done

    if is_async:

        async def create_async(*args: Any, **kwargs: Any) -> Any:
            run = context.current_run()
            if run is None:
                return await original(*args, **kwargs)
            started = datetime.now(timezone.utc)
            inp, params, model = split_message_params(kwargs)
            try:
                result = await original(*args, **kwargs)
            except Exception as err:
                _record(run, model, inp, params, None, started, None, error=f"{type(err).__name__}: {err}")
                raise
            if kwargs.get("stream"):
                return _TappedStream(result, on_done_for(run, model, inp, params, started))
            _record(run, model, inp, params, result, started, None)
            return result

        messages.create = create_async
    else:

        def create_sync(*args: Any, **kwargs: Any) -> Any:
            run = context.current_run()
            if run is None:
                return original(*args, **kwargs)
            started = datetime.now(timezone.utc)
            inp, params, model = split_message_params(kwargs)
            try:
                result = original(*args, **kwargs)
            except Exception as err:
                _record(run, model, inp, params, None, started, None, error=f"{type(err).__name__}: {err}")
                raise
            if kwargs.get("stream"):
                return _TappedStream(result, on_done_for(run, model, inp, params, started))
            _record(run, model, inp, params, result, started, None)
            return result

        messages.create = create_sync
    return client
