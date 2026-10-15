from __future__ import annotations

import functools
import inspect
import time
from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime, timezone
from typing import Any, Generic, ParamSpec, TypeVar, cast, overload

from . import context
from .fingerprint import tool_fingerprint
from .replay import ReplayState

P = ParamSpec("P")
R = TypeVar("R")

# Module-level replay state, set by Overturn.replay_mode(); lets @tool work without a client reference.
_replay: ReplayState | None = None


def set_replay_state(state: ReplayState | None) -> None:
    global _replay
    _replay = state


def get_replay_state() -> ReplayState | None:
    return _replay


class Tool(Generic[P, R]):
    """A wrapped tool. Call it like the original function."""

    def __init__(
        self,
        fn: Callable[P, R],
        *,
        name: str | None = None,
        side_effect: bool = False,
        match_on: Sequence[str] | None = None,
        ignore_args: Sequence[str] | None = None,
        description: str | None = None,
    ) -> None:
        self.fn = fn
        self.name = name or fn.__name__
        self.side_effect = side_effect
        self.match_on = list(match_on) if match_on else None
        self.ignore_args = list(ignore_args) if ignore_args else None
        self.description = description or inspect.getdoc(fn)
        self._sig = inspect.signature(fn)
        self._is_async = inspect.iscoroutinefunction(fn)
        functools.update_wrapper(self, fn)

    def bind_args(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        try:
            bound = self._sig.bind(*args, **kwargs)
            bound.apply_defaults()
            return dict(bound.arguments)
        except TypeError:
            return {"args": list(args), **kwargs}

    def fingerprint(self, *args: Any, **kwargs: Any) -> str:
        return tool_fingerprint(self.name, self.bind_args(*args, **kwargs), self.match_on, self.ignore_args)

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> R:
        bound = self.bind_args(*args, **kwargs)
        fp = tool_fingerprint(self.name, bound, self.match_on, self.ignore_args)
        run = context.current_run()
        started = datetime.now(timezone.utc)
        replay = _replay or (run.client.replay if run else None)

        if replay is not None:
            output = replay.answer(self.name, bound, fp, self.side_effect)
            if run:
                run.step(
                    kind="tool_call",
                    name=self.name,
                    input=bound,
                    output=output,
                    side_effect=self.side_effect,
                    fingerprint=fp,
                    latency_ms=0,
                    started_at=started,
                )
            if self._is_async:

                async def _ready() -> Any:
                    return output

                return cast(R, _ready())
            return cast(R, output)

        if self._is_async:
            return cast(R, self._call_async(bound, fp, run, started, *args, **kwargs))

        t0 = time.perf_counter()
        try:
            output = self.fn(*args, **kwargs)
        except Exception as err:
            if run:
                run.step(
                    kind="tool_call",
                    name=self.name,
                    input=bound,
                    error=f"{type(err).__name__}: {err}",
                    side_effect=self.side_effect,
                    fingerprint=fp,
                    latency_ms=(time.perf_counter() - t0) * 1000,
                    started_at=started,
                )
            raise
        if run:
            run.step(
                kind="tool_call",
                name=self.name,
                input=bound,
                output=output,
                side_effect=self.side_effect,
                fingerprint=fp,
                latency_ms=(time.perf_counter() - t0) * 1000,
                started_at=started,
            )
        return output

    async def _call_async(
        self, bound: dict[str, Any], fp: str, run: Any, started: datetime, *args: P.args, **kwargs: P.kwargs
    ) -> Any:
        t0 = time.perf_counter()
        try:
            output = await cast(Awaitable[Any], self.fn(*args, **kwargs))
        except Exception as err:
            if run:
                run.step(
                    kind="tool_call",
                    name=self.name,
                    input=bound,
                    error=f"{type(err).__name__}: {err}",
                    side_effect=self.side_effect,
                    fingerprint=fp,
                    latency_ms=(time.perf_counter() - t0) * 1000,
                    started_at=started,
                )
            raise
        if run:
            run.step(
                kind="tool_call",
                name=self.name,
                input=bound,
                output=output,
                side_effect=self.side_effect,
                fingerprint=fp,
                latency_ms=(time.perf_counter() - t0) * 1000,
                started_at=started,
            )
        return output


@overload
def tool(fn: Callable[P, R], /) -> Tool[P, R]: ...
@overload
def tool(
    *,
    name: str | None = None,
    side_effect: bool = False,
    match_on: Sequence[str] | None = None,
    ignore_args: Sequence[str] | None = None,
    description: str | None = None,
) -> Callable[[Callable[P, R]], Tool[P, R]]: ...


def tool(
    fn: Callable[P, R] | None = None,
    /,
    *,
    name: str | None = None,
    side_effect: bool = False,
    match_on: Sequence[str] | None = None,
    ignore_args: Sequence[str] | None = None,
    description: str | None = None,
) -> Tool[P, R] | Callable[[Callable[P, R]], Tool[P, R]]:
    """Decorator: record every call of this function as a tool_call step on the current run.

    @tool(side_effect=False, match_on=["email"])
    def lookup_customer(email: str) -> dict: ...
    """

    def wrap(f: Callable[P, R]) -> Tool[P, R]:
        return Tool(
            f,
            name=name,
            side_effect=side_effect,
            match_on=match_on,
            ignore_args=ignore_args,
            description=description,
        )

    return wrap(fn) if fn is not None else wrap
