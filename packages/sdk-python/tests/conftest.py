# pyright: basic
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from overturn import Overturn


@dataclass
class Capture:
    ov: Overturn
    batches: list[dict[str, Any]] = field(default_factory=lambda: [])

    def steps(self) -> list[dict[str, Any]]:
        return [s for b in self.batches for s in b["steps"]]

    def runs(self) -> list[dict[str, Any]]:
        return [r for b in self.batches for r in b["runs"]]


def make_capture(handler: Callable[[dict[str, Any], int], int] | None = None, **kwargs: Any) -> Capture:
    batches: list[dict[str, Any]] = []

    def app(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        batches.append(payload)
        status = handler(payload, len(batches)) if handler else 202
        return httpx.Response(status, json={} if status < 400 else {"message": "nope"})

    client = httpx.Client(transport=httpx.MockTransport(app))
    ov = Overturn(api_key="ov_live_test", base_url="http://x", http_client=client, background=False, **kwargs)
    return Capture(ov=ov, batches=batches)


@pytest.fixture
def capture() -> Capture:
    return make_capture()
