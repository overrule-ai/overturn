# pyright: basic
from __future__ import annotations

import json
from typing import Any

import httpx

from overturn.transport import Transport, build_payload
from overturn.types import RunUpsert


def run(id: str, **extra: Any) -> RunUpsert:
    base: dict[str, Any] = {
        "id": id,
        "agent": "a",
        "status": "running",
        "started_at": "2026-10-15T10:00:00.000Z",
    }
    return RunUpsert(**{**base, **extra})


def make(handler: Any, **kwargs: Any) -> tuple[Transport, list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []

    def app(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        return httpx.Response(handler(len(calls)))

    t = Transport(
        "k",
        "http://x/",
        http_client=httpx.Client(transport=httpx.MockTransport(app)),
        background=False,
        backoff_s=0.001,
        **kwargs,
    )
    return t, calls


def test_build_payload_merges_same_id() -> None:
    p = build_payload(
        [("run", run("r1", input={"x": 1})), ("run", run("r1", status="completed", output={"y": 2}))]
    )
    assert len(p["runs"]) == 1
    assert p["runs"][0]["status"] == "completed"
    assert p["runs"][0]["input"] == {"x": 1}
    assert p["runs"][0]["output"] == {"y": 2}
    assert p["v"] == 1
    assert "startedAt" in p["runs"][0]  # camelCase on the wire


def test_batches_and_flushes() -> None:
    t, calls = make(lambda _n: 202, max_batch_size=3)
    t.enqueue_run(run("r1"))
    t.enqueue_run(run("r2"))
    t.enqueue_run(run("r3"))
    t.flush()
    assert len(calls) == 1
    assert [r["id"] for r in calls[0]["runs"]] == ["r1", "r2", "r3"]
    assert t.stats["sent"] == 3


def test_retries_5xx_then_succeeds() -> None:
    errors: list[int] = []
    t, calls = make(lambda n: 503 if n < 3 else 202, on_error=lambda _e, _d, a: errors.append(a))
    t.enqueue_run(run("r1"))
    t.flush()
    assert len(calls) == 3
    assert errors == [0, 1]
    assert t.stats["dropped"] == 0


def test_4xx_is_not_retried() -> None:
    dropped: list[bool] = []
    t, calls = make(lambda _n: 400, on_error=lambda _e, d, _a: dropped.append(d))
    t.enqueue_run(run("r1"))
    t.flush()
    assert len(calls) == 1
    assert dropped == [True]
    assert t.stats["dropped"] == 1


def test_gives_up_after_max_retries_without_raising() -> None:
    def boom(_n: int) -> int:
        raise ConnectionError("refused")

    t, _calls = make(boom, max_retries=2)
    t.enqueue_run(run("r1"))
    t.flush()
    assert t.stats["dropped"] == 1
    assert t.stats["retries"] == 2


def test_queue_overflow_drops_oldest() -> None:
    t, _ = make(lambda _n: 202, max_queue_size=2, max_batch_size=100)
    t.enqueue_run(run("r1"))
    t.enqueue_run(run("r2"))
    t.enqueue_run(run("r3"))
    assert t.pending == 2
    assert t.stats["dropped"] == 1


def test_background_thread_flushes_on_interval() -> None:
    import time

    calls: list[int] = []

    def app(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(202)

    t = Transport(
        "k", "http://x", http_client=httpx.Client(transport=httpx.MockTransport(app)), flush_interval_s=0.02
    )
    t.enqueue_run(run("r1"))
    time.sleep(0.2)
    assert calls, "background thread did not flush"
    t.close()
