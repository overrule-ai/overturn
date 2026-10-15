"""Fingerprint contract, version 1. Mirrors packages/shared/src/fingerprint.ts byte for byte.

    fingerprint = sha256(kind + "\\n" + name + "\\n" + canonical_json(select_args(args)))

See docs/fingerprint.md. Any change here must change the TypeScript implementation and
the shared vectors in packages/shared/src/fingerprint.vectors.json.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

FINGERPRINT_VERSION = 1


def _js_number(n: float | int) -> str:
    """Serialize a number the way JavaScript's Number#toString does."""
    if isinstance(n, int):
        return str(n)
    if math.isnan(n) or math.isinf(n):
        return "null"
    if n == 0.0:
        return "0"
    if n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    sign, raw_digits, exp = Decimal(repr(n)).as_tuple()
    digits = list(raw_digits)
    if not isinstance(exp, int):  # pragma: no cover - NaN/Inf handled above
        return "null"
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exp += 1
    k = len(digits)
    e = exp + k  # value = 0.d1...dk * 10^e
    s = "".join(str(d) for d in digits)
    if k <= e <= 21:
        out = s + "0" * (e - k)
    elif 0 < e <= 21:
        out = s[:e] + "." + s[e:]
    elif -6 < e <= 0:
        out = "0." + "0" * (-e) + s
    else:
        ex = e - 1
        mant = s[0] + ("." + s[1:] if k > 1 else "")
        out = f"{mant}e{'+' if ex >= 0 else '-'}{abs(ex)}"
    return ("-" if sign else "") + out


def _dumps_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False, separators=(",", ":"))


def canonical_json(value: Any) -> str:
    """Canonical JSON: sorted keys, null/None dropped, strings trimmed, numbers normalized, arrays ordered."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _dumps_str(value.strip())
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, Decimal):
        return _js_number(float(value))
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        iso = dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return _dumps_str(iso)
    if isinstance(value, Mapping):
        m = cast(Mapping[Any, Any], value)
        keys = sorted(str(k) for k, v in m.items() if v is not None)
        lookup: dict[str, Any] = {str(k): v for k, v in m.items()}
        return "{" + ",".join(_dumps_str(k) + ":" + canonical_json(lookup[k]) for k in keys) + "}"
    if isinstance(value, (list, tuple, set, frozenset)) or (
        isinstance(value, Sequence) and not isinstance(value, (str, bytes))
    ):
        seq: Sequence[Any] = list(value)  # type: ignore[arg-type]
        return "[" + ",".join(canonical_json(x) for x in seq if x is not None) + "]"
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return canonical_json(cast(Callable[[], Any], dump)())
    if hasattr(value, "__dict__"):
        return canonical_json(vars(value))
    return "null"


def select_args(
    args: Any,
    match_on: Sequence[str] | None = None,
    ignore_args: Sequence[str] | None = None,
) -> Any:
    if not isinstance(args, Mapping):
        return args
    m: Mapping[str, Any] = args  # type: ignore[assignment]
    if match_on:
        return {k: m[k] for k in match_on if k in m}
    if ignore_args:
        return {k: v for k, v in m.items() if k not in ignore_args}
    return dict(m)


def fingerprint(
    kind: str,
    name: str,
    args: Any,
    match_on: Sequence[str] | None = None,
    ignore_args: Sequence[str] | None = None,
) -> str:
    c = canonical_json(select_args(args, match_on, ignore_args))
    return hashlib.sha256(f"{kind}\n{name}\n{c}".encode()).hexdigest()


def tool_fingerprint(
    name: str,
    args: Any,
    match_on: Sequence[str] | None = None,
    ignore_args: Sequence[str] | None = None,
) -> str:
    return fingerprint("tool_call", name, args, match_on, ignore_args)


def hash_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()
