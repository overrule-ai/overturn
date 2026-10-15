# pyright: basic
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from overturn.fingerprint import canonical_json, hash_json, select_args, tool_fingerprint

VECTORS = Path(__file__).resolve().parents[2] / "shared" / "src" / "fingerprint.vectors.json"


def test_shared_vectors_match_typescript() -> None:
    vectors: list[dict[str, Any]] = json.loads(VECTORS.read_text())
    assert len(vectors) >= 9
    for v in vectors:
        opts = v.get("options", {})
        assert canonical_json(v["args"]) == v["canonical"], v["name"]
        assert (
            tool_fingerprint(v["tool"], v["args"], opts.get("matchOn"), opts.get("ignoreArgs"))
            == v["fingerprint"]
        ), v["name"]


def test_canonical_rules() -> None:
    assert canonical_json({"b": 1, "a": {"d": 2, "c": 3}}) == '{"a":{"c":3,"d":2},"b":1}'
    assert canonical_json({"a": None, "c": [1, None, 2]}) == '{"c":[1,2]}'
    assert canonical_json({"q": "  hello  "}) == '{"q":"hello"}'
    assert (
        canonical_json({"a": 1.0, "b": -0.0, "c": 1e21, "d": 0.1 + 0.2})
        == '{"a":1,"b":0,"c":1e+21,"d":0.30000000000000004}'
    )
    assert canonical_json([3, 1, 2]) == "[3,1,2]"
    assert canonical_json(True) == "true"
    assert canonical_json(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)) == '"2026-01-02T03:04:05.000Z"'


def test_js_number_edge_cases() -> None:
    assert canonical_json(1e-7) == "1e-7"
    assert canonical_json(0.00001) == "0.00001"
    assert canonical_json(1.5e300) == "1.5e+300"
    assert canonical_json(float("nan")) == "null"
    assert canonical_json(-2.5) == "-2.5"
    assert canonical_json(123456789012345680000.0) == "123456789012345683968"


def test_select_args() -> None:
    assert select_args({"a": 1, "b": 2}, match_on=["a"], ignore_args=["a"]) == {"a": 1}
    assert select_args({"a": 1, "ts": 2}, ignore_args=["ts"]) == {"a": 1}
    assert select_args("x", match_on=["a"]) == "x"


def test_hash_json_stable() -> None:
    assert hash_json({"a": 1}) == hash_json({"a": 1.0})
