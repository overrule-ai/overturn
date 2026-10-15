"""Replay mode: tools are answered from a case's recordings and never execute.

Two guarantees, each covered by a test in tests/test_replay.py:
 1. A tool call whose fingerprint has no recording raises UnreplayableError; the real tool is not called.
 2. A tool declared side_effect=True is refused outright, even when a recording exists.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict


class ToolRecording(TypedDict):
    name: str
    args: Any
    output: Any


ToolRecordings = dict[str, ToolRecording]


class UnreplayableError(Exception):
    def __init__(self, tool_name: str, args: Any, fingerprint: str) -> None:
        super().__init__(
            f'No recording for tool "{tool_name}" with fingerprint {fingerprint[:12]}…; the real tool was not executed'
        )
        self.tool_name = tool_name
        self.args = args
        self.fingerprint = fingerprint


class SideEffectRefusedError(Exception):
    def __init__(self, tool_name: str, args: Any) -> None:
        super().__init__(f'Tool "{tool_name}" is marked side_effect=True and is refused in replay mode')
        self.tool_name = tool_name
        self.args = args


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
    calls: list[ReplayCall] = field(default_factory=lambda: [])

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
