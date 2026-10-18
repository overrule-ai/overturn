"""Replay mode: tools are answered from a case's recordings and never execute.

Two guarantees, each covered by a test in tests/test_replay.py:
 1. A tool call whose fingerprint has no recording raises UnreplayableError; the real tool is not called.
 2. A tool declared side_effect=True is refused outright, even when a recording exists.

With `model_call` set, wrapped model clients answer from the target model (trajectory replay);
every step is collected on the state instead of being sent to the API.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from .types import StepUpsert


class ToolRecording(TypedDict):
    name: str
    args: Any
    output: Any


ToolRecordings = dict[str, ToolRecording]


class UnreplayableError(Exception):
    def __init__(self, tool_name: str, args: Any, fingerprint: str) -> None:
        super().__init__(
            f'No recording for tool "{tool_name}" with fingerprint {fingerprint[:12]}…; '
            "the real tool was not executed"
        )
        self.tool_name = tool_name
        self.tool_args = args
        self.fingerprint = fingerprint


class SideEffectRefusedError(Exception):
    def __init__(self, tool_name: str, args: Any) -> None:
        super().__init__(f'Tool "{tool_name}" is marked side_effect=True and is refused in replay mode')
        self.tool_name = tool_name
        self.tool_args = args  # not `args`: that is BaseException's message tuple


class MaxStepsExceededError(Exception):
    def __init__(self, max_steps: int) -> None:
        super().__init__(f"Replay stopped: the agent exceeded max_steps ({max_steps})")
        self.max_steps = max_steps


class ReplayModelOutput(TypedDict, total=False):
    text: str
    toolCalls: list[dict[str, Any]]
    finishReason: str
    usage: dict[str, Any]
    modelId: str | None
    costUsd: float | None


ReplayModelCall = Callable[[dict[str, Any]], ReplayModelOutput]
"""Normalized model call for trajectory replay: receives {provider, messages, system, tools,
tool_choice, response_format, params} and returns the target model's answer."""


@dataclass
class ReplayCall:
    name: str
    args: Any
    fingerprint: str
    status: Literal["answered", "unseen", "refused"]


@dataclass
class ReplayState:
    recordings: ToolRecordings
    allow_side_effects: bool = False
    model_call: ReplayModelCall | None = None
    max_steps: int = 50
    calls: list[ReplayCall] = field(default_factory=lambda: [])
    steps: list[StepUpsert] = field(default_factory=lambda: [])

    def answer(self, name: str, args: Any, fingerprint: str, side_effect: bool) -> Any:
        if side_effect and not self.allow_side_effects:
            self.calls.append(ReplayCall(name, args, fingerprint, "refused"))
            raise SideEffectRefusedError(name, args)
        rec = self.recordings.get(fingerprint)
        if rec is None:
            self.calls.append(ReplayCall(name, args, fingerprint, "unseen"))
            raise UnreplayableError(name, args, fingerprint)
        self.calls.append(ReplayCall(name, args, fingerprint, "answered"))
        return rec["output"]

    def record(self, step: StepUpsert) -> None:
        self.steps.append(step)
        if len(self.steps) > self.max_steps:
            raise MaxStepsExceededError(self.max_steps)
