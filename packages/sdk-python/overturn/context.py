from __future__ import annotations

from contextvars import ContextVar
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .run import Run

_current_run: ContextVar[Run | None] = ContextVar("overturn_current_run", default=None)
_parent_step: ContextVar[str | None] = ContextVar("overturn_parent_step", default=None)


def current_run() -> Run | None:
    return _current_run.get()


def parent_step_id() -> str | None:
    return _parent_step.get()
