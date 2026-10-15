# pyright: basic
"""The two replay guarantees: unseen fingerprints never execute; side-effect tools are refused outright."""

from __future__ import annotations

from typing import Any

import pytest

from overturn import SideEffectRefusedError, UnreplayableError, tool
from tests.conftest import Capture


def test_answers_from_recordings_without_executing(capture: Capture) -> None:
    executed = 0

    @tool
    def lookup(email: str) -> dict[str, str]:
        nonlocal executed
        executed += 1
        return {"live": email}

    fp = lookup.fingerprint("a@b.c")
    capture.ov.replay_mode({fp: {"name": "lookup", "args": {"email": "a@b.c"}, "output": {"recorded": True}}})
    try:
        with capture.ov.run(agent="a"):
            assert lookup("a@b.c") == {"recorded": True}
        assert executed == 0
    finally:
        capture.ov.exit_replay_mode()


def test_unseen_fingerprint_raises_and_never_executes(capture: Capture) -> None:
    executed = 0

    @tool
    def lookup(email: str) -> int:
        nonlocal executed
        executed += 1
        return 1

    state = capture.ov.replay_mode({})
    try:
        with pytest.raises(UnreplayableError):
            lookup("new@b.c")
        assert executed == 0
        assert state.calls[0].status == "unseen"
    finally:
        capture.ov.exit_replay_mode()


def test_side_effect_tools_are_refused_even_with_recording(capture: Capture) -> None:
    executed = 0

    @tool(side_effect=True)
    def send_email(to: str) -> str:
        nonlocal executed
        executed += 1
        return "sent"

    fp = send_email.fingerprint("x")
    capture.ov.replay_mode({fp: {"name": "send_email", "args": {"to": "x"}, "output": "sent"}})
    try:
        with pytest.raises(SideEffectRefusedError):
            send_email("x")
        assert executed == 0
    finally:
        capture.ov.exit_replay_mode()
    assert send_email("x") == "sent"


async def test_async_tool_in_replay(capture: Capture) -> None:
    @tool
    async def fetch(url: str) -> str:
        raise AssertionError("must not execute")

    fp = fetch.fingerprint("u")
    capture.ov.replay_mode({fp: {"name": "fetch", "args": {"url": "u"}, "output": "cached"}})
    try:
        assert await fetch("u") == "cached"
    finally:
        capture.ov.exit_replay_mode()


def test_model_call_swaps_the_model_and_collects_steps(capture: Capture) -> None:
    from tests.test_recording import FakeOpenAI

    seen: list[dict[str, Any]] = []

    def model_call(inp: dict[str, Any]) -> Any:
        seen.append(inp)
        return {
            "text": '{"priority":"P0"}',
            "toolCalls": [],
            "finishReason": "stop",
            "usage": {"inputTokens": 1},
            "modelId": "target",
        }

    state = capture.ov.replay_mode({}, model_call=model_call)
    try:
        openai = capture.ov.wrap_openai(FakeOpenAI())
        with capture.ov.run(agent="a"):
            completion = openai.chat.completions.create(
                model="gpt-4.1-mini", messages=[{"role": "user", "content": "x"}]
            )
        assert completion["model"] == "target"
        assert completion["choices"][0]["message"]["content"] == '{"priority":"P0"}'
        assert seen[0]["provider"] == "openai" and seen[0]["messages"] == [{"role": "user", "content": "x"}]
        assert [s.name for s in state.steps] == ["chat.completions"]
        capture.ov.flush()
        assert capture.batches == []  # nothing recorded as a production run
    finally:
        capture.ov.exit_replay_mode()


def test_max_steps(capture: Capture) -> None:
    from overturn import MaxStepsExceededError

    @tool
    def t() -> int:
        return 1

    capture.ov.replay_mode({t.fingerprint(): {"name": "t", "args": {}, "output": 1}}, max_steps=2)
    try:
        with pytest.raises(MaxStepsExceededError), capture.ov.run(agent="a"):
            t()
            t()
            t()
    finally:
        capture.ov.exit_replay_mode()
