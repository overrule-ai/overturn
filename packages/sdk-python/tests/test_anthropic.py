# pyright: basic
from __future__ import annotations

from typing import Any

from overturn.anthropic_wrap import assemble_message_stream
from tests.conftest import Capture


class FakeMessages:
    def create(self, **params: Any) -> Any:
        if params.get("stream"):
            return iter(
                [
                    {
                        "type": "message_start",
                        "message": {
                            "model": "claude-haiku-4-5",
                            "role": "assistant",
                            "usage": {"input_tokens": 7, "output_tokens": 0},
                        },
                    },
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""},
                    },
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": "Hel"},
                    },
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": "lo"},
                    },
                    {
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": {"type": "tool_use", "id": "tu_1", "name": "set_pri", "input": {}},
                    },
                    {
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": {"type": "input_json_delta", "partial_json": '{"p": '},
                    },
                    {
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": {"type": "input_json_delta", "partial_json": '"P1"}'},
                    },
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": "tool_use"},
                        "usage": {"output_tokens": 9},
                    },
                    {"type": "message_stop"},
                ]
            )
        return {
            "id": "msg_1",
            "model": "claude-haiku-4-5-20251001",
            "role": "assistant",
            "content": [{"type": "text", "text": "P1"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 2},
        }


class FakeAnthropic:
    def __init__(self) -> None:
        self.messages = FakeMessages()


def test_wrap_anthropic_records(capture: Capture) -> None:
    client = capture.ov.wrap_anthropic(FakeAnthropic())
    with capture.ov.run(agent="a"):
        client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=100,
            system="be brief",
            messages=[{"role": "user", "content": "hi"}],
        )
    capture.ov.flush()
    step = capture.steps()[0]
    assert step["provider"] == "anthropic"
    assert step["name"] == "messages"
    assert step["model"] == "claude-haiku-4-5-20251001"
    assert step["input"] == {"system": "be brief", "messages": [{"role": "user", "content": "hi"}]}
    assert step["params"] == {"max_tokens": 100}
    assert step["output"]["message"]["content"] == [{"type": "text", "text": "P1"}]
    assert step["output"]["finish_reason"] == "end_turn"
    assert step["usage"]["inputTokens"] == 10 and step["usage"]["totalTokens"] == 12
    assert step["costUsd"] is not None


def test_wrap_anthropic_streams(capture: Capture) -> None:
    client = capture.ov.wrap_anthropic(FakeAnthropic())
    with capture.ov.run(agent="a"):
        events = list(client.messages.create(model="m", max_tokens=5, messages=[], stream=True))
    assert len(events) == 9
    capture.ov.flush()
    step = capture.steps()[0]
    content = step["output"]["message"]["content"]
    assert content[0] == {"type": "text", "text": "Hello"}
    assert content[1]["type"] == "tool_use" and content[1]["input"] == {"p": "P1"}
    assert step["output"]["finish_reason"] == "tool_use"
    assert step["usage"]["inputTokens"] == 7 and step["usage"]["outputTokens"] == 9


def test_assemble_empty() -> None:
    assert assemble_message_stream([])["content"] == []
