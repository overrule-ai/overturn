from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

StepKind = Literal["llm_call", "tool_call", "retrieval", "human"]
RunStatus = Literal["running", "completed", "failed"]
CorrectionKind = Literal["approve", "edit", "reject", "escalate"]

INGEST_VERSION = 1


class Usage(BaseModel):
    model_config = ConfigDict(extra="allow")

    input_tokens: int | None = Field(default=None, serialization_alias="inputTokens")
    output_tokens: int | None = Field(default=None, serialization_alias="outputTokens")
    total_tokens: int | None = Field(default=None, serialization_alias="totalTokens")
    cached_input_tokens: int | None = Field(default=None, serialization_alias="cachedInputTokens")
    first_token_ms: float | None = Field(default=None, serialization_alias="firstTokenMs")


class RunUpsert(BaseModel):
    id: str
    agent: str
    status: RunStatus
    started_at: str = Field(serialization_alias="startedAt")
    external_id: str | None = Field(default=None, serialization_alias="externalId")
    agent_version: str | None = Field(default=None, serialization_alias="agentVersion")
    input: Any = None
    output: Any = None
    metadata: dict[str, Any] | None = None
    tags: list[str] | None = None
    ended_at: str | None = Field(default=None, serialization_alias="endedAt")
    error: str | None = None


class StepUpsert(BaseModel):
    id: str
    run_id: str = Field(serialization_alias="runId")
    seq: int
    kind: StepKind
    name: str
    started_at: str = Field(serialization_alias="startedAt")
    parent_step_id: str | None = Field(default=None, serialization_alias="parentStepId")
    input: Any = None
    output: Any = None
    model: str | None = None
    provider: str | None = None
    params: dict[str, Any] | None = None
    usage: Usage | None = None
    cost_usd: float | None = Field(default=None, serialization_alias="costUsd")
    latency_ms: float | None = Field(default=None, serialization_alias="latencyMs")
    error: str | None = None
    side_effect: bool = Field(default=False, serialization_alias="sideEffect")
    fingerprint: str | None = None
    ended_at: str | None = Field(default=None, serialization_alias="endedAt")


class IngestPayload(BaseModel):
    v: int = INGEST_VERSION
    runs: list[RunUpsert] = Field(default_factory=lambda: [])
    steps: list[StepUpsert] = Field(default_factory=lambda: [])


def to_wire(model: BaseModel) -> dict[str, Any]:
    """Serialize with camelCase aliases, dropping None so the server can coalesce."""
    return model.model_dump(by_alias=True, exclude_none=True, mode="json")
