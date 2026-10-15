"""wrap_openai: record chat.completions.create (sync and async, streaming or not) as llm_call steps."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Iterator
from datetime import datetime, timezone
from typing import Any, TypeVar, cast

from . import context
from ._json import as_dict, get_dict, get_int, get_list, get_str, is_jsonable
from .pricing import estimate_cost_usd
from .types import Usage

T = TypeVar("T")

_INPUT_KEYS = {"messages", "tools", "tool_choice", "response_format", "functions", "function_call"}
_SKIP_KEYS = {"model", "stream", "stream_options", *_INPUT_KEYS}


def split_chat_params(params: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], str | None]:
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


def _usage_from(completion: Any) -> Usage | None:
    u = _dump(completion).get("usage")
    if u is None:
        return None
    d = _dump(u)
    details = get_dict(d, "prompt_tokens_details")
    return Usage(
        input_tokens=get_int(d, "prompt_tokens"),
        output_tokens=get_int(d, "completion_tokens"),
        total_tokens=get_int(d, "total_tokens"),
        cached_input_tokens=get_int(details, "cached_tokens"),
    )


def _record(
    run: Any,
    model: str | None,
    inp: Any,
    params: Any,
    completion: Any,
    started: datetime,
    first_token_ms: float | None,
    error: str | None = None,
) -> None:
    if run is None:
        return
    usage = _usage_from(completion) if completion is not None else None
    if usage is not None and first_token_ms is not None:
        usage.first_token_ms = first_token_ms
    resolved_model = (get_str(_dump(completion), "model") if completion is not None else None) or model
    output: dict[str, Any] | None = None
    if completion is not None:
        choices = get_list(_dump(completion), "choices")
        if choices:
            first = as_dict(choices[0])
            output = {"message": first.get("message"), "finish_reason": first.get("finish_reason")}
    run.step(
        kind="llm_call",
        name="chat.completions",
        provider="openai",
        model=resolved_model,
        input=inp,
        params=params,
        output=output,
        usage=usage,
        cost_usd=estimate_cost_usd(resolved_model, usage),
        latency_ms=(datetime.now(timezone.utc) - started).total_seconds() * 1000,
        error=error,
        started_at=started,
    )


def assemble_chat_stream(chunks: list[Any]) -> Any:
    """Rebuilds a chat.completion-shaped dict from streamed chunks."""
    content: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    finish: str | None = None
    usage: Any = None
    model: str | None = None
    role = "assistant"
    for c in chunks:
        d = _dump(c)
        model = model or get_str(d, "model")
        if d.get("usage"):
            usage = d["usage"]
        choices = get_list(d, "choices")
        if not choices:
            continue
        ch = as_dict(choices[0])
        if get_str(ch, "finish_reason"):
            finish = get_str(ch, "finish_reason")
        delta = get_dict(ch, "delta")
        if get_str(delta, "role"):
            role = get_str(delta, "role") or role
        if get_str(delta, "content"):
            content.append(get_str(delta, "content") or "")
        for raw_tc in get_list(delta, "tool_calls"):
            tc = as_dict(raw_tc)
            idx = get_int(tc, "index") or 0
            cur = tool_calls.setdefault(
                idx,
                {
                    "id": tc.get("id"),
                    "type": get_str(tc, "type") or "function",
                    "function": {"name": "", "arguments": ""},
                },
            )
            if get_str(tc, "id"):
                cur["id"] = tc["id"]
            fn = get_dict(tc, "function")
            cur["function"]["name"] += get_str(fn, "name") or ""
            cur["function"]["arguments"] += get_str(fn, "arguments") or ""
    message: dict[str, Any] = {"role": role, "content": "".join(content) if content else None}
    if tool_calls:
        message["tool_calls"] = [tool_calls[i] for i in sorted(tool_calls)]
    return _Completion(model=model, choices=[{"message": message, "finish_reason": finish}], usage=usage)


class _Completion:
    def __init__(self, model: str | None, choices: list[dict[str, Any]], usage: Any) -> None:
        self.model = model
        self.choices = choices
        self.usage = usage

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return {"model": self.model, "choices": self.choices, "usage": self.usage}


class _TappedStream:
    """Iterates the real stream, yields every chunk to the caller, records when done."""

    def __init__(self, stream: Any, on_done: Any) -> None:
        self._stream = stream
        self._on_done = on_done
        self._chunks: list[Any] = []
        self._t0 = time.perf_counter()
        self._first: float | None = None

    def __iter__(self) -> Iterator[Any]:
        try:
            for chunk in self._stream:
                if self._first is None:
                    self._first = (time.perf_counter() - self._t0) * 1000
                self._chunks.append(chunk)
                yield chunk
        finally:
            self._on_done(self._chunks, self._first)

    def __aiter__(self) -> AsyncIterator[Any]:
        return self._aiter()

    async def _aiter(self) -> AsyncIterator[Any]:
        try:
            async for chunk in self._stream:
                if self._first is None:
                    self._first = (time.perf_counter() - self._t0) * 1000
                self._chunks.append(chunk)
                yield chunk
        finally:
            self._on_done(self._chunks, self._first)

    def __getattr__(self, item: str) -> Any:
        return getattr(self._stream, item)

    def __enter__(self) -> _TappedStream:
        return self

    def __exit__(self, *_: Any) -> None:
        close = getattr(self._stream, "close", None)
        if callable(close):
            close()


def wrap_openai(client: T) -> T:
    """Patches client.chat.completions.create in place (works for OpenAI and AsyncOpenAI)."""
    completions = cast(Any, client).chat.completions
    original = completions.create
    is_async = _is_async_client(client)

    def record_stream(run: Any, model: str | None, inp: Any, params: Any, started: datetime) -> Any:
        def on_done(chunks: list[Any], first: float | None) -> None:
            _record(run, model, inp, params, assemble_chat_stream(chunks), started, first)

        return on_done

    if is_async:

        async def create_async(*args: Any, **kwargs: Any) -> Any:
            run = context.current_run()
            if run is None:
                return await original(*args, **kwargs)
            started = datetime.now(timezone.utc)
            inp, params, model = split_chat_params(kwargs)
            if kwargs.get("stream"):
                kwargs.setdefault("stream_options", {"include_usage": True})
            try:
                result = await original(*args, **kwargs)
            except Exception as err:
                _record(run, model, inp, params, None, started, None, error=f"{type(err).__name__}: {err}")
                raise
            if kwargs.get("stream"):
                return _TappedStream(result, record_stream(run, model, inp, params, started))
            _record(run, model, inp, params, result, started, None)
            return result

        completions.create = create_async
    else:

        def create_sync(*args: Any, **kwargs: Any) -> Any:
            run = context.current_run()
            if run is None:
                return original(*args, **kwargs)
            started = datetime.now(timezone.utc)
            inp, params, model = split_chat_params(kwargs)
            if kwargs.get("stream"):
                kwargs.setdefault("stream_options", {"include_usage": True})
            try:
                result = original(*args, **kwargs)
            except Exception as err:
                _record(run, model, inp, params, None, started, None, error=f"{type(err).__name__}: {err}")
                raise
            if kwargs.get("stream"):
                return _TappedStream(result, record_stream(run, model, inp, params, started))
            _record(run, model, inp, params, result, started, None)
            return result

        completions.create = create_sync
    return client


def _is_async_client(client: Any) -> bool:
    name = type(client).__name__
    return name.startswith("Async")
