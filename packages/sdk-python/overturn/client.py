from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from typing import Any, ParamSpec, TypeVar

import httpx

from . import context
from . import tools as _tools
from .anthropic_wrap import wrap_anthropic
from .api import CorrectionKind, OverturnApi
from .openai_wrap import wrap_openai
from .replay import ReplayModelCall, ReplayState, ToolRecordings
from .run import Run
from .tools import Tool
from .transport import OnError, Transport
from .types import RunUpsert, StepUpsert

P = ParamSpec("P")
R = TypeVar("R")
T = TypeVar("T")

Redact = Callable[[StepUpsert], StepUpsert | None]


class Overturn:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        *,
        redact: Redact | None = None,
        enabled: bool = True,
        debug: bool | None = None,
        on_error: OnError | None = None,
        flush_interval_s: float = 1.0,
        max_batch_size: int = 100,
        http_client: httpx.Client | None = None,
        background: bool = True,
    ) -> None:
        self.api_key = api_key or os.environ.get("OVERTURN_API_KEY", "")
        self.base_url = base_url or os.environ.get("OVERTURN_BASE_URL", "https://api.overturn.run")
        self.debug = debug if debug is not None else os.environ.get("OVERTURN_DEBUG") == "1"
        self.redact = redact
        self.replay: ReplayState | None = None
        self.transport: Transport | None = None
        self.api = OverturnApi(self.api_key, self.base_url, http_client=http_client)
        if enabled and self.api_key:
            self.transport = Transport(
                self.api_key,
                self.base_url,
                flush_interval_s=flush_interval_s,
                max_batch_size=max_batch_size,
                on_error=on_error,
                debug=self.debug,
                http_client=http_client,
                background=background,
            )
        elif enabled and self.debug:
            print("[overturn] no API key set; nothing will be recorded")

    # ---- sink ----
    def emit_run(self, run: RunUpsert) -> None:
        if _tools.get_replay_state() is not None:
            return  # replay runs are never recorded as production runs
        if self.transport:
            self.transport.enqueue_run(run)

    def emit_step(self, step: StepUpsert) -> None:
        replay = _tools.get_replay_state()
        if replay is not None:
            replay.record(step)
            return
        if not self.transport:
            return
        out = self.redact(step) if self.redact else step
        if out is not None:
            self.transport.enqueue_step(out)

    # ---- API ----
    def run(
        self,
        agent: str,
        *,
        version: str | None = None,
        input: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        external_id: str | None = None,
        id: str | None = None,
    ) -> Run:
        """Start a run. Use as a context manager: `with ov.run(agent="x") as run: ...`"""
        return Run(
            self,
            agent=agent,
            version=version,
            input=input,
            tags=tags,
            metadata=metadata,
            external_id=external_id,
            id=id,
        )

    start_run = run

    def current_run(self) -> Run | None:
        return context.current_run()

    def tool(
        self,
        name: str,
        fn: Callable[P, R],
        *,
        side_effect: bool = False,
        match_on: Sequence[str] | None = None,
        ignore_args: Sequence[str] | None = None,
        description: str | None = None,
    ) -> Tool[P, R]:
        return Tool(
            fn,
            name=name,
            side_effect=side_effect,
            match_on=match_on,
            ignore_args=ignore_args,
            description=description,
        )

    def wrap_openai(self, client: T) -> T:
        return wrap_openai(client)

    def wrap_anthropic(self, client: T) -> T:
        return wrap_anthropic(client)

    def correct(
        self,
        *,
        run_id: str,
        kind: CorrectionKind,
        step_id: str | None = None,
        corrected_output: Any = None,
        note: str | None = None,
        actor: str | None = None,
    ) -> dict[str, Any]:
        """Record a human correction and freeze a regression case. Sent immediately; returns
        {"correction": ..., "case": ...}."""
        body: dict[str, Any] = {"runId": run_id, "kind": kind, "source": "sdk"}
        if step_id is not None:
            body["stepId"] = step_id
        if corrected_output is not None:
            body["correctedOutput"] = corrected_output
        if note is not None:
            body["note"] = note
        if actor is not None:
            body["actor"] = actor
        return self.api.create_correction(body)

    def replay_mode(
        self,
        recordings: ToolRecordings,
        *,
        allow_side_effects: bool = False,
        model_call: ReplayModelCall | None = None,
        max_steps: int = 50,
    ) -> ReplayState:
        """Every @tool is answered from recordings and never executed, until exit_replay_mode().
        With model_call, wrapped model clients answer from the target model instead of the provider."""
        self.replay = ReplayState(
            recordings, allow_side_effects=allow_side_effects, model_call=model_call, max_steps=max_steps
        )
        _tools.set_replay_state(self.replay)
        return self.replay

    def exit_replay_mode(self) -> None:
        self.replay = None
        _tools.set_replay_state(None)

    def flush(self) -> None:
        if self.transport:
            self.transport.flush()

    def shutdown(self) -> None:
        if self.transport:
            self.transport.close()
