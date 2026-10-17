"""Batched, background, retrying ingest. Never raises into the caller's agent."""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx

from .types import INGEST_VERSION, RunUpsert, StepUpsert, to_wire

OnError = Callable[[Exception, bool, int], None]
"""(error, dropped, attempt)"""


class TransportError(Exception):
    def __init__(self, message: str, status: int | None = None, retryable: bool = True) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class Transport:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        flush_interval_s: float = 1.0,
        max_batch_size: int = 100,
        max_queue_size: int = 10_000,
        max_retries: int = 5,
        backoff_s: float = 0.5,
        timeout_s: float = 10.0,
        on_error: OnError | None = None,
        debug: bool = False,
        http_client: httpx.Client | None = None,
        background: bool = True,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.flush_interval_s = flush_interval_s
        self.max_batch_size = max_batch_size
        self.max_queue_size = max_queue_size
        self.max_retries = max_retries
        self.backoff_s = backoff_s
        self.on_error = on_error
        self.debug = debug
        self._client = http_client or httpx.Client(timeout=timeout_s)
        self._queue: list[tuple[str, Any]] = []
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._closed = False
        self.stats: dict[str, int] = {"sent": 0, "batches": 0, "retries": 0, "dropped": 0}
        self._thread: threading.Thread | None = None
        if background:
            self._thread = threading.Thread(target=self._loop, name="overturn-ingest", daemon=True)
            self._thread.start()

    # ---- enqueue ----
    def enqueue_run(self, run: RunUpsert) -> None:
        self._push(("run", run))

    def enqueue_step(self, step: StepUpsert) -> None:
        self._push(("step", step))

    @property
    def pending(self) -> int:
        with self._lock:
            return len(self._queue)

    def _push(self, item: tuple[str, Any]) -> None:
        if self._closed:
            return
        with self._lock:
            self._queue.append(item)
            overflow = len(self._queue) - self.max_queue_size
            if overflow > 0:
                del self._queue[:overflow]
                self.stats["dropped"] += overflow
                self._report(
                    TransportError(f"queue overflow, dropped {overflow} items", retryable=False), True, 0
                )
            full = len(self._queue) >= self.max_batch_size
        if full:
            self._wake.set()

    # ---- background loop ----
    def _loop(self) -> None:
        while not self._closed:
            self._wake.wait(self.flush_interval_s)
            self._wake.clear()
            self._drain()

    def _drain(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    return
                batch = self._queue[: self.max_batch_size]
                del self._queue[: self.max_batch_size]
            self._send_with_retry(build_payload(batch))

    def flush(self) -> None:
        """Sends everything queued, synchronously, from the calling thread."""
        self._drain()

    def close(self) -> None:
        self.flush()
        self._closed = True
        self._wake.set()
        self._client.close()

    # ---- sending ----
    def _send_with_retry(self, payload: dict[str, Any]) -> None:
        count = len(payload["runs"]) + len(payload["steps"])
        for attempt in range(self.max_retries + 1):
            try:
                self._send(payload)
                self.stats["sent"] += count
                self.stats["batches"] += 1
                return
            except Exception as err:  # noqa: BLE001 - we never raise into the agent
                retryable = not isinstance(err, TransportError) or err.retryable
                last = attempt == self.max_retries or not retryable
                self._report(err, last, attempt)
                if last:
                    self.stats["dropped"] += count
                    return
                self.stats["retries"] += 1
                time.sleep(min(self.backoff_s * (2**attempt), 30.0) * (0.5 + random.random()))

    def _send(self, payload: dict[str, Any]) -> None:
        res = self._client.post(
            f"{self.base_url}/v1/ingest",
            json=payload,
            headers={
                "authorization": f"Bearer {self.api_key}",
                "user-agent": f"overturn-sdk-python/{_version()}",
            },
        )
        if res.is_success:
            return
        retryable = res.status_code >= 500 or res.status_code in (408, 429)
        raise TransportError(f"ingest failed: {res.status_code} {res.text[:300]}", res.status_code, retryable)

    def _report(self, err: Exception, dropped: bool, attempt: int) -> None:
        if self.debug:
            print(f"[overturn] ingest attempt {attempt + 1} failed: {err}")
        if self.on_error:
            try:
                self.on_error(err, dropped, attempt)
            except Exception:  # noqa: BLE001
                pass


def build_payload(items: list[tuple[str, Any]]) -> dict[str, Any]:
    runs: dict[str, dict[str, Any]] = {}
    steps: dict[str, dict[str, Any]] = {}
    for kind, data in items:
        wire = to_wire(data)
        target = runs if kind == "run" else steps
        prev = target.get(wire["id"])
        target[wire["id"]] = {**prev, **wire} if prev else wire
    return {"v": INGEST_VERSION, "runs": list(runs.values()), "steps": list(steps.values())}


def _version() -> str:
    from . import __version__

    return __version__
