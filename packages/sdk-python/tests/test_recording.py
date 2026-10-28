# pyright: basic
from __future__ import annotations

from typing import Any

import pytest

from overturn import StepUpsert, tool, tool_fingerprint
from tests.conftest import Capture, make_capture


class FakeCompletions:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def create(self, **params: Any) -> Any:
        self.calls.append(params)
        if params.get("stream"):
            return iter(
                [
                    {
                        "model": "m",
                        "choices": [{"delta": {"role": "assistant", "content": ""}, "finish_reason": None}],
                    },
                    {
                        "model": "m",
                        "choices": [
                            {
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "c1",
                                            "type": "function",
                                            "function": {"name": "set_pri", "arguments": '{"p":'},
                                        }
                                    ]
                                },
                                "finish_reason": None,
                            }
                        ],
                    },
                    {
                        "model": "m",
                        "choices": [
                            {
                                "delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"P1"}'}}]},
                                "finish_reason": "tool_calls",
                            }
                        ],
                    },
                    {
                        "model": "m",
                        "choices": [],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
                    },
                ]
            )
        return {
            "id": "cmpl_1",
            "model": "gpt-4.1-mini-2025-04-14",
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": "P1"}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
        }


class FakeChat:
    def __init__(self) -> None:
        self.completions = FakeCompletions()


class FakeOpenAI:
    def __init__(self) -> None:
        self.chat = FakeChat()


def test_records_run_tools_and_llm_calls(capture: Capture) -> None:
    ov = capture.ov

    @tool(side_effect=False, match_on=["email"])
    def lookup_customer(email: str, ts: int = 0) -> dict[str, str]:
        return {"plan": "pro", "email": email}

    set_priority = ov.tool("set_priority", lambda ticket_id, priority: {"ok": True}, side_effect=True)  # type: ignore[misc]
    openai = ov.wrap_openai(FakeOpenAI())

    with ov.run(agent="triage", version="1.0.0", input={"id": "T1"}, tags=["test"]) as run:
        lookup_customer("a@b.c", ts=1)
        openai.chat.completions.create(
            model="gpt-4.1-mini", messages=[{"role": "user", "content": "hi"}], temperature=0
        )
        set_priority("T1", "P1")
        run.end(output={"priority": "P1"})
    ov.flush()

    runs = capture.runs()
    assert len(runs) == 1
    assert runs[0]["status"] == "completed"
    assert runs[0]["input"] == {"id": "T1"}
    assert runs[0]["output"] == {"priority": "P1"}
    assert runs[0]["tags"] == ["test"]
    assert runs[0]["agentVersion"] == "1.0.0"

    steps = capture.steps()
    assert [(s["seq"], s["kind"], s["name"]) for s in steps] == [
        (0, "tool_call", "lookup_customer"),
        (1, "llm_call", "chat.completions"),
        (2, "tool_call", "set_priority"),
    ]
    assert all(s["runId"] == run.id for s in steps)
    assert steps[0]["fingerprint"] == tool_fingerprint("lookup_customer", {"email": "a@b.c"})
    assert steps[0]["input"] == {"email": "a@b.c", "ts": 1}
    assert steps[0]["sideEffect"] is False
    assert steps[2]["sideEffect"] is True
    llm = steps[1]
    assert llm["model"] == "gpt-4.1-mini-2025-04-14"
    assert llm["provider"] == "openai"
    assert llm["input"] == {"messages": [{"role": "user", "content": "hi"}]}
    assert llm["params"] == {"temperature": 0}
    assert llm["output"] == {"message": {"role": "assistant", "content": "P1"}, "finish_reason": "stop"}
    assert llm["usage"]["inputTokens"] == 10 and llm["usage"]["outputTokens"] == 2
    assert llm["costUsd"] == pytest.approx((10 * 0.4 + 2 * 1.6) / 1e6)


def test_streams_are_buffered(capture: Capture) -> None:
    ov = capture.ov
    openai = ov.wrap_openai(FakeOpenAI())
    with ov.run(agent="triage"):
        n = sum(1 for _ in openai.chat.completions.create(model="m", messages=[], stream=True))
    assert n == 4
    ov.flush()
    llm = capture.steps()[0]
    assert llm["output"]["message"]["tool_calls"][0]["function"] == {
        "name": "set_pri",
        "arguments": '{"p":"P1"}',
    }
    assert llm["usage"]["inputTokens"] == 5
    assert isinstance(llm["usage"]["firstTokenMs"], float)


def test_tool_errors_are_recorded_and_reraised(capture: Capture) -> None:
    @tool
    def boom() -> None:
        raise ValueError("kaboom")

    with pytest.raises(ValueError), capture.ov.run(agent="a"):
        boom()
    capture.ov.flush()
    assert capture.steps()[0]["error"] == "ValueError: kaboom"
    assert capture.runs()[0]["status"] == "failed"


def test_no_run_context_is_a_noop(capture: Capture) -> None:
    @tool
    def add(a: int) -> int:
        return a + 1

    assert add(1) == 2
    capture.ov.flush()
    assert capture.steps() == []


def test_redact_hook() -> None:
    def redact(step: StepUpsert) -> StepUpsert | None:
        if step.name == "secret":
            return None
        return step.model_copy(update={"input": "[redacted]"})

    cap = make_capture(redact=redact)

    @tool
    def a(pw: str) -> int:
        return len(pw)

    @tool
    def secret() -> int:
        return 1

    with cap.ov.run(agent="r"):
        a("hunter2")
        secret()
    cap.ov.flush()
    steps = cap.steps()
    assert len(steps) == 1
    assert steps[0]["input"] == "[redacted]"


async def test_async_tools(capture: Capture) -> None:
    @tool(match_on=["q"])
    async def search(q: str) -> list[str]:
        return [q]

    with capture.ov.run(agent="a"):
        assert await search("x") == ["x"]
    capture.ov.flush()
    assert capture.steps()[0]["output"] == ["x"]


def test_nested_runs(capture: Capture) -> None:
    @tool
    def t() -> int:
        return 1

    with capture.ov.run(agent="outer") as outer:
        t()
        with capture.ov.run(agent="inner") as inner:
            t()
        t()
    capture.ov.flush()
    assert [s["runId"] for s in capture.steps()] == [outer.id, inner.id, outer.id]


def test_correct_posts_immediately() -> None:
    import httpx

    seen: list[tuple[str, dict[str, Any]]] = []

    def app(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.append((request.url.path, _json.loads(request.content)))
        return httpx.Response(
            201, json={"correction": {"id": "c1"}, "case": {"id": "k1", "scorer": "json_match"}}
        )

    from overturn import Overturn

    ov = Overturn(
        api_key="k",
        base_url="http://x",
        http_client=httpx.Client(transport=httpx.MockTransport(app)),
        background=False,
    )
    out = ov.correct(run_id="r1", kind="edit", corrected_output={"priority": "P1"}, note="n", actor="a")
    assert out["case"]["id"] == "k1"
    assert seen[0][0] == "/v1/corrections"
    assert seen[0][1] == {
        "runId": "r1",
        "kind": "edit",
        "source": "sdk",
        "correctedOutput": {"priority": "P1"},
        "note": "n",
        "actor": "a",
    }


def test_handle_correction_validates_and_uses_the_sessions_actor() -> None:
    import json

    import httpx

    from overturn import CorrectionRequestError, Overturn

    seen: list[dict[str, Any]] = []

    def app(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(201, json={"correction": {"id": "c1"}, "case": {"id": "k1"}})

    ov = Overturn(
        api_key="k",
        base_url="http://x",
        http_client=httpx.Client(transport=httpx.MockTransport(app)),
        background=False,
    )
    run_id = "01a14c81-adc1-749a-a32c-3d5c8017bd53"
    out = ov.handle_correction(
        {
            "runId": run_id,
            "kind": "edit",
            "correctedOutput": {"priority": "P0"},
            "note": "outage",
            "actor": "spoof",
        },
        actor="sam@x.io",
    )
    assert out["case"]["id"] == "k1"
    assert seen[0] == {
        "runId": run_id,
        "kind": "edit",
        "source": "sdk",
        "correctedOutput": {"priority": "P0"},
        "note": "outage",
        "actor": "sam@x.io",
    }
    for bad in (
        {"runId": "nope", "kind": "approve"},
        {"runId": run_id, "kind": "undo"},
        [],
        {"runId": run_id, "kind": "approve", "stepId": 1},
    ):
        with pytest.raises(CorrectionRequestError):
            ov.handle_correction(bad)
    assert len(seen) == 1


def test_capture_posts_draft_and_sent() -> None:
    import httpx

    seen: list[tuple[str, dict[str, Any]]] = []

    def app(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.append((request.url.path, _json.loads(request.content)))
        return httpx.Response(201, json={"kind": "edit", "changed": True, "case": {"id": "k2"}})

    from overturn import Overturn

    ov = Overturn(
        api_key="k",
        base_url="http://x",
        http_client=httpx.Client(transport=httpx.MockTransport(app)),
        background=False,
    )
    out = ov.capture(
        external_id="zd:1",
        agent="claims-reply",
        source="zendesk",
        context=[{"role": "customer", "content": "hi"}],
        draft="Covered.",
        sent={"text": "Covered, adjuster in 2 days.", "fields": {"status": "covered"}},
        reason="2-day SLA",
    )
    assert out["case"]["id"] == "k2"
    assert seen[0][0] == "/v1/capture"
    assert seen[0][1] == {
        "externalId": "zd:1",
        "agent": "claims-reply",
        "source": "zendesk",
        "context": [{"role": "customer", "content": "hi"}],
        "draft": {"text": "Covered."},
        "sent": {"text": "Covered, adjuster in 2 days.", "fields": {"status": "covered"}},
        "reason": "2-day SLA",
    }
