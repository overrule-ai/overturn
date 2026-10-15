from __future__ import annotations

from contextvars import Token
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from uuid_utils import uuid7

from . import context
from .types import RunUpsert, StepKind, StepUpsert, Usage

if TYPE_CHECKING:
    from .client import Overturn


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Run:
    """One agent trajectory. Use as a context manager so wrapped clients and tools attach to it."""

    def __init__(
        self,
        client: Overturn,
        *,
        agent: str,
        version: str | None = None,
        input: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        external_id: str | None = None,
        id: str | None = None,
    ) -> None:
        self.client = client
        self.id = id or str(uuid7())
        self.agent = agent
        self.version = version
        self.started_at = _now()
        self._seq = 0
        self._ended = False
        self._token: Token[Run | None] | None = None
        client.emit_run(
            RunUpsert(
                id=self.id,
                agent=agent,
                agent_version=version,
                external_id=external_id,
                status="running",
                input=input,
                tags=tags or [],
                metadata=metadata,
                started_at=_iso(self.started_at),
            )
        )

    # ---- context manager ----
    def __enter__(self) -> Run:
        self._token = context._current_run.set(self)  # pyright: ignore[reportPrivateUsage]
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: object) -> None:
        if self._token is not None:
            context._current_run.reset(self._token)  # pyright: ignore[reportPrivateUsage]
            self._token = None
        if exc is not None and not self._ended:
            self.end(error=f"{exc_type.__name__ if exc_type else 'Error'}: {exc}")
        elif not self._ended:
            self.end()

    async def __aenter__(self) -> Run:
        return self.__enter__()

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: object
    ) -> None:
        self.__exit__(exc_type, exc, tb)

    # ---- recording ----
    def next_seq(self) -> int:
        seq = self._seq
        self._seq += 1
        return seq

    def step(
        self,
        *,
        kind: StepKind,
        name: str,
        input: Any = None,
        output: Any = None,
        model: str | None = None,
        provider: str | None = None,
        params: dict[str, Any] | None = None,
        usage: Usage | None = None,
        cost_usd: float | None = None,
        latency_ms: float | None = None,
        error: str | None = None,
        side_effect: bool = False,
        fingerprint: str | None = None,
        started_at: datetime | None = None,
        ended_at: datetime | None = None,
        parent_step_id: str | None = None,
        id: str | None = None,
    ) -> str:
        step_id = id or str(uuid7())
        start = started_at or _now()
        self.client.emit_step(
            StepUpsert(
                id=step_id,
                run_id=self.id,
                parent_step_id=parent_step_id if parent_step_id is not None else context.parent_step_id(),
                seq=self.next_seq(),
                kind=kind,
                name=name,
                input=input,
                output=output,
                model=model,
                provider=provider,
                params=params,
                usage=usage,
                cost_usd=cost_usd,
                latency_ms=latency_ms,
                error=error,
                side_effect=side_effect,
                fingerprint=fingerprint,
                started_at=_iso(start),
                ended_at=_iso(ended_at or _now()),
            )
        )
        return step_id

    def end(self, output: Any = None, error: str | None = None) -> None:
        """Marks the run completed (or failed). Idempotent."""
        if self._ended:
            return
        self._ended = True
        self.client.emit_run(
            RunUpsert(
                id=self.id,
                agent=self.agent,
                agent_version=self.version,
                status="failed" if error else "completed",
                output=output,
                error=error,
                started_at=_iso(self.started_at),
                ended_at=_iso(_now()),
            )
        )

    @property
    def is_ended(self) -> bool:
        return self._ended
