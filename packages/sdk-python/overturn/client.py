from __future__ import annotations

import os
import re
from collections.abc import Callable, Sequence
from typing import Any, ParamSpec, TypeVar, cast

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
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class CorrectionRequestError(ValueError):
    """A browser correction payload that handle_correction() refused; respond 400 with str(err)."""

    status = 400


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
        scorer: str | None = None,
        scorer_config: dict[str, Any] | None = None,
        contract: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Record a human correction and freeze a regression case. Sent immediately; returns
        {"correction": ..., "case": ...}. The scorer is picked from the answer's shape unless given.
        `contract` is a list of hard rules checked on every replay, e.g.
        [{"type": "tool_called", "tool": "refund", "count": "never"},
         {"type": "answer", "contains": "P0"}]."""
        body: dict[str, Any] = {"runId": run_id, "kind": kind, "source": "sdk"}
        if contract is not None:
            body["contract"] = contract
        if scorer is not None:
            body["scorer"] = scorer
        if scorer_config is not None:
            body["scorerConfig"] = scorer_config
        if step_id is not None:
            body["stepId"] = step_id
        if corrected_output is not None:
            body["correctedOutput"] = corrected_output
        if note is not None:
            body["note"] = note
        if actor is not None:
            body["actor"] = actor
        return self.api.create_correction(body)

    def examples(
        self, *, input: str, k: int = 5, agent: str | None = None, tag: str | None = None
    ) -> dict[str, Any]:
        """Corrections in the prompt: the k human-approved cases nearest to `input` and a
        `promptBlock` to append to the system prompt, so the model you already run learns from
        every correction without a retrain. One embedding plus a lookup per call.

            ex = ov.examples(input=ticket["body"], k=5, agent="ticket-triage")
            system = SYSTEM_PROMPT + ex["promptBlock"]
        """
        params: dict[str, Any] = {"input": input, "k": k}
        if agent is not None:
            params["agent"] = agent
        if tag is not None:
            params["tag"] = tag
        return self.api.get_examples(params)

    def promoted_model(self) -> str | None:
        """The owned model a human promoted for this project (provider/model), or None."""
        project = self.api.request("GET", "/v1/project")
        settings = cast("dict[str, Any]", project.get("settings") or {})
        model: Any = settings.get("promotedModel")
        return model if isinstance(model, str) else None

    def handle_correction(self, payload: Any, *, actor: str | None = None) -> dict[str, Any]:
        """Turn what <CorrectButton> (from @overturn-ai/sdk/react) posts into a correction, from
        your own route: validates the body, uses the actor from YOUR session, calls correct().
        Raises CorrectionRequestError (status 400) for a bad body.

            @app.post("/api/overturn/correct")
            def correct(body: dict, user=Depends(current_user)):
                return ov.handle_correction(body, actor=user.email)
        """
        if not isinstance(payload, dict):
            raise CorrectionRequestError("body must be a JSON object")
        body: dict[str, Any] = {str(k): v for k, v in cast("dict[Any, Any]", payload).items()}
        run_id = body.get("runId")
        kind = body.get("kind")
        if not isinstance(run_id, str) or not _UUID_RE.match(run_id):
            raise CorrectionRequestError("runId must be a UUID")
        if kind not in ("approve", "edit", "reject", "escalate"):
            raise CorrectionRequestError("kind must be approve, edit, reject or escalate")
        step_id = body.get("stepId")
        if step_id is not None and (not isinstance(step_id, str) or not _UUID_RE.match(step_id)):
            raise CorrectionRequestError("stepId must be a UUID or null")
        note = body.get("note")
        if note is not None and (not isinstance(note, str) or len(note) > 10_000):
            raise CorrectionRequestError("note must be a string under 10000 characters")
        contract = body.get("contract")
        if contract is not None and (
            not isinstance(contract, list)
            or len(cast("list[Any]", contract)) > 8
            or not all(isinstance(r, dict) and "type" in r for r in cast("list[Any]", contract))
        ):
            raise CorrectionRequestError("contract must be a list of at most 8 rule objects")
        return self.correct(
            run_id=run_id,
            kind=kind,
            step_id=step_id,
            corrected_output=body.get("correctedOutput"),
            note=note,
            actor=actor,
            contract=cast("list[dict[str, Any]] | None", contract),
        )

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
