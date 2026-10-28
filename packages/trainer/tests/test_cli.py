"""The trainer against a fake Overturn API: export in, manifest out, register with the gate's answer."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from overturn_trainer.cli import main

ROWS = [
    {
        "messages": [
            {"role": "system", "content": "triage"},
            {"role": "user", "content": f"ticket {i}"},
            {"role": "assistant", "content": '{"priority":"P1"}'},
        ]
    }
    for i in range(6)
]


CALLS: list[dict[str, Any]] = []


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: Any) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.startswith("/v1/export/stats"):
            return self._json(200, {"rows": len(ROWS), "byKind": {"approve": 6}, "format": "sft"})
        if self.path.startswith("/v1/export"):
            CALLS.append({"export": self.path, "auth": self.headers.get("authorization")})
            text = "\n".join(json.dumps(r) for r in ROWS) + "\n"
            data = text.encode()
            self.send_response(200)
            self.send_header("content-type", "application/jsonl")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._json(404, {"message": "no"})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/v1/models/register":
            CALLS.append({"register": body})
            return self._json(
                201,
                {
                    "name": body.get("name") or "ext-1",
                    "servedAs": body["servedAs"],
                    "status": "passed",
                    "gate": {"pass": True, "reasons": []},
                },
            )
        self._json(404, {"message": "no"})

    def log_message(self, format: str, *args: Any) -> None:
        return


@pytest.fixture()
def server() -> Any:
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    CALLS.clear()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_run_dry_exports_writes_manifest_and_registers(server: str, tmp_path: Path) -> None:
    out = tmp_path / "model"
    code = main(
        [
            "run",
            "--base",
            "Qwen/Qwen2.5-7B-Instruct",
            "--out",
            str(out),
            "--backend",
            "dry",
            "--agent",
            "ticket-triage",
            "--min-rows",
            "5",
            "--register",
            "local/triage-lora",
            "--name",
            "mine",
            "--api-key",
            "ov_test",
            "--base-url",
            server,
        ]
    )
    assert code == 0
    assert (out / "train-sft.jsonl").read_text().count("\n") == 6
    manifest = json.loads((out / "overturn-manifest.json").read_text())
    assert manifest == {
        "backend": "dry",
        "base_model": "Qwen/Qwen2.5-7B-Instruct",
        "method": "sft",
        "rows": 6,
        "epochs": 3,
        "lora_r": 16,
        "output_dir": str(out),
        "seconds": manifest["seconds"],
        "merged": False,
    }
    exp = next(c for c in CALLS if "export" in c)
    assert "format=sft" in exp["export"] and "agent=ticket-triage" in exp["export"]
    assert exp["auth"] == "Bearer ov_test"
    reg = next(c for c in CALLS if "register" in c)["register"]
    assert reg == {
        "name": "mine",
        "baseModel": "Qwen/Qwen2.5-7B-Instruct",
        "servedAs": "local/triage-lora",
        "method": "sft",
        "epochs": 3,
        "filter": {"agent": "ticket-triage"},
        "datasetStats": {"rows": 6, "byKind": {"approve": 6}, "format": "sft"},
    }


def test_refuses_under_min_rows(server: str, tmp_path: Path) -> None:
    code = main(
        [
            "run",
            "--base",
            "x/y",
            "--out",
            str(tmp_path),
            "--backend",
            "dry",
            "--api-key",
            "k",
            "--base-url",
            server,
        ]
    )
    assert code == 2
    assert not (tmp_path / "overturn-manifest.json").exists()
