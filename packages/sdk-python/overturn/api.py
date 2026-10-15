"""Thin typed-ish client for the Overturn REST API (used by correct())."""

from __future__ import annotations

from typing import Any, Literal

import httpx

from ._json import as_dict

CorrectionKind = Literal["approve", "edit", "reject", "escalate"]


class OverturnApiError(Exception):
    def __init__(self, status: int, body: Any, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class OverturnApi:
    def __init__(self, api_key: str, base_url: str, http_client: httpx.Client | None = None) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._client = http_client or httpx.Client(timeout=30.0)

    def request(self, method: str, path: str, body: Any = None, params: dict[str, Any] | None = None) -> Any:
        res = self._client.request(
            method,
            f"{self.base_url}{path}",
            json=body,
            params={k: v for k, v in (params or {}).items() if v is not None},
            headers={"authorization": f"Bearer {self.api_key}", "user-agent": "overturn-sdk-python/0.1.0"},
        )
        parsed: Any = res.json() if res.content else None
        if not res.is_success:
            msg = as_dict(parsed).get("message", res.text[:200])
            raise OverturnApiError(
                res.status_code, parsed, f"{method} {path} failed: {res.status_code} {msg}"
            )
        return parsed

    # ---- endpoints ----
    def me(self) -> dict[str, Any]:
        return self.request("GET", "/v1/me")

    def list_runs(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/runs", params=params)

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/runs/{run_id}")

    def create_correction(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/v1/corrections", body=body)

    def list_cases(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/cases", params=params)

    def get_case(self, case_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/cases/{case_id}")
