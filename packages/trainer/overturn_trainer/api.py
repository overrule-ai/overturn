"""The two Overturn calls the trainer needs: pull the export, register the result."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx


class OverturnApi:
    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key or os.environ.get("OVERTURN_API_KEY") or ""
        self.base_url = (
            base_url or os.environ.get("OVERTURN_BASE_URL") or "https://api.overturn.run"
        ).rstrip("/")
        if not self.api_key:
            raise SystemExit("OVERTURN_API_KEY is not set (Settings → API keys)")
        self._client = httpx.Client(timeout=120)

    def _headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.api_key}", "user-agent": "overturn-trainer/0.1.0"}

    def export(self, fmt: str, **params: Any) -> list[dict[str, Any]]:
        """`GET /v1/export?format=sft|dpo` as rows (one JSON object per JSONL line)."""
        res = self._client.get(
            f"{self.base_url}/v1/export",
            params={"format": fmt, **{k: v for k, v in params.items() if v is not None}},
            headers=self._headers(),
        )
        if not res.is_success:
            raise SystemExit(f"export failed: {res.status_code} {res.text[:200]}")
        return [json.loads(line) for line in res.text.splitlines() if line.strip()]

    def export_stats(self, fmt: str, **params: Any) -> dict[str, Any]:
        res = self._client.get(
            f"{self.base_url}/v1/export/stats",
            params={"format": fmt, **{k: v for k, v in params.items() if v is not None}},
            headers=self._headers(),
        )
        if not res.is_success:
            raise SystemExit(f"export stats failed: {res.status_code} {res.text[:200]}")
        return res.json()

    def register(self, body: dict[str, Any]) -> dict[str, Any]:
        """`POST /v1/models/register`: the gate replays the suite against `servedAs` at once."""
        res = self._client.post(f"{self.base_url}/v1/models/register", json=body, headers=self._headers())
        if not res.is_success:
            raise SystemExit(f"register failed: {res.status_code} {res.text[:300]}")
        return res.json()
