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
            headers={
                "authorization": f"Bearer {self.api_key}",
                "user-agent": f"overturn-sdk-python/{_version()}",
            },
        )
        parsed: Any = res.json() if res.content else None
        if not res.is_success:
            msg = as_dict(parsed).get("message", res.text[:200])
            raise OverturnApiError(
                res.status_code, parsed, f"{method} {path} failed: {res.status_code} {msg}"
            )
        return parsed

    # ---- endpoints (flat) ----
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

    def patch_case(self, case_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("PATCH", f"/v1/cases/{case_id}", body=body)

    def get_examples(self, params: dict[str, Any]) -> dict[str, Any]:
        """Corrections in the prompt: nearest human-approved cases for an input (see Overturn.examples)."""
        return self.request("GET", "/v1/examples", params=params)

    def export_stats(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/export/stats", params=params)

    def list_corrections(self, **params: Any) -> list[dict[str, Any]]:
        return self.request("GET", "/v1/corrections", params=params)

    def estimate_replay(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/v1/replays/estimate", body=body)

    def create_replay(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/v1/replays", body=body)

    def list_replays(self, **params: Any) -> list[dict[str, Any]]:
        return self.request("GET", "/v1/replays", params=params)

    def get_replay(self, job_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/replays/{job_id}")

    def cancel_replay(self, job_id: str) -> dict[str, Any]:
        return self.request("POST", f"/v1/replays/{job_id}/cancel")

    def replay_results(self, job_id: str) -> list[dict[str, Any]]:
        return self.request("GET", f"/v1/replays/{job_id}/results")

    def replay_report(self, job_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/replays/{job_id}/report")

    def replay_matrix(self, group_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/replays/groups/{group_id}")

    def post_replay_results(self, job_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"/v1/replays/{job_id}/results", body=body)

    def register_prompt(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/v1/prompts", body=body)

    def list_prompts(self) -> list[dict[str, Any]]:
        return self.request("GET", "/v1/prompts")

    def get_project(self) -> dict[str, Any]:
        return self.request("GET", "/v1/project")

    def patch_project(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("PATCH", "/v1/project", body=body)

    # ---- namespaced, mirroring the TypeScript client (ov.api.runs.list(), ...) ----
    @property
    def runs(self) -> _Runs:
        return _Runs(self)

    @property
    def cases(self) -> _Cases:
        return _Cases(self)

    @property
    def corrections(self) -> _Corrections:
        return _Corrections(self)

    @property
    def replays(self) -> _Replays:
        return _Replays(self)

    @property
    def prompts(self) -> _Prompts:
        return _Prompts(self)

    @property
    def project(self) -> _Project:
        return _Project(self)


class _Runs:
    def __init__(self, api: OverturnApi) -> None:
        self._api = api

    def list(self, **params: Any) -> dict[str, Any]:
        return self._api.list_runs(**params)

    def get(self, run_id: str) -> dict[str, Any]:
        return self._api.get_run(run_id)


class _Cases:
    def __init__(self, api: OverturnApi) -> None:
        self._api = api

    def list(self, **params: Any) -> dict[str, Any]:
        return self._api.list_cases(**params)

    def get(self, case_id: str) -> dict[str, Any]:
        return self._api.get_case(case_id)

    def patch(self, case_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._api.patch_case(case_id, body)


class _Corrections:
    def __init__(self, api: OverturnApi) -> None:
        self._api = api

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._api.create_correction(body)

    def list(self, **params: Any) -> list[dict[str, Any]]:
        return self._api.list_corrections(**params)


class _Replays:
    def __init__(self, api: OverturnApi) -> None:
        self._api = api

    def estimate(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._api.estimate_replay(body)

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._api.create_replay(body)

    def list(self, **params: Any) -> list[dict[str, Any]]:
        return self._api.list_replays(**params)

    def get(self, job_id: str) -> dict[str, Any]:
        return self._api.get_replay(job_id)

    def cancel(self, job_id: str) -> dict[str, Any]:
        return self._api.cancel_replay(job_id)

    def results(self, job_id: str) -> list[dict[str, Any]]:
        return self._api.replay_results(job_id)

    def report(self, job_id: str) -> dict[str, Any]:
        return self._api.replay_report(job_id)

    def matrix(self, group_id: str) -> dict[str, Any]:
        return self._api.replay_matrix(group_id)

    def post_results(self, job_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._api.post_replay_results(job_id, body)


class _Prompts:
    def __init__(self, api: OverturnApi) -> None:
        self._api = api

    def register(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._api.register_prompt(body)

    def list(self) -> list[dict[str, Any]]:
        return self._api.list_prompts()


class _Project:
    def __init__(self, api: OverturnApi) -> None:
        self._api = api

    def get(self) -> dict[str, Any]:
        return self._api.get_project()

    def patch(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._api.patch_project(body)


def _version() -> str:
    from . import __version__

    return __version__
