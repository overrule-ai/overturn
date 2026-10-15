"""Small typed accessors for loosely-typed JSON-like data (SDK response dumps)."""

from __future__ import annotations

from typing import Any, cast


def as_dict(v: Any) -> dict[str, Any]:
    return cast(dict[str, Any], v) if isinstance(v, dict) else {}


def as_list(v: Any) -> list[Any]:
    return cast(list[Any], v) if isinstance(v, list) else []


def get_dict(d: dict[str, Any], key: str) -> dict[str, Any]:
    return as_dict(d.get(key))


def get_list(d: dict[str, Any], key: str) -> list[Any]:
    return as_list(d.get(key))


def get_str(d: dict[str, Any], key: str) -> str | None:
    v = d.get(key)
    return v if isinstance(v, str) else None


def get_int(d: dict[str, Any], key: str) -> int | None:
    v = d.get(key)
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def is_jsonable(v: Any) -> bool:
    return isinstance(v, (str, int, float, bool, list, dict))
