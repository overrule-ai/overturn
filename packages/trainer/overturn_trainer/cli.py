"""`overturn-trainer run`: export → fine-tune (LoRA) → save → register with Overturn for the gate."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, cast

from .api import OverturnApi
from .train import train


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="overturn-trainer", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser(
        "run", help="Export, train a LoRA, save it, and (optionally) register it for the gate"
    )
    run.add_argument(
        "--base", required=True, help="Hugging Face model id, e.g. meta-llama/Llama-3.1-8B-Instruct"
    )
    run.add_argument(
        "--out", default="./overturn-model", help="Output directory (adapter/, merged/, manifest)"
    )
    run.add_argument("--method", choices=["sft", "dpo"], default="sft")
    run.add_argument("--epochs", type=int, default=3)
    run.add_argument("--lora-r", type=int, default=16)
    run.add_argument("--learning-rate", type=float, default=2e-4)
    run.add_argument("--max-seq-length", type=int, default=4096)
    run.add_argument("--merge", action="store_true", help="Also save merged full weights (merged/)")
    run.add_argument("--agent", help="Only this agent's cases")
    run.add_argument("--tag", help="Only cases with this tag")
    run.add_argument("--since", help="Cases since (ISO date or 30d)")
    run.add_argument("--min-rows", type=int, default=50, help="Refuse to train on fewer rows than this")
    run.add_argument("--backend", choices=["trl", "dry"], default="trl")
    run.add_argument(
        "--register",
        metavar="PROVIDER/MODEL",
        help="Where the weights will answer from (e.g. local/triage-lora); registers the model so the gate runs",
    )
    run.add_argument("--name", help="Model name in Overturn")
    run.add_argument("--api-key", help="Overturn API key (default: OVERTURN_API_KEY)")
    run.add_argument("--base-url", help="Overturn API URL (default: OVERTURN_BASE_URL or hosted)")
    return p


def cmd_run(a: argparse.Namespace) -> int:
    api = OverturnApi(a.api_key, a.base_url)
    params: dict[str, Any] = {"agent": a.agent, "tag": a.tag, "since": a.since, "includeApproved": "true"}
    stats = api.export_stats(a.method, **params)
    rows_n = int(stats.get("rows", 0))
    if rows_n < a.min_rows:
        print(
            f"{rows_n} {a.method} rows is under --min-rows {a.min_rows}. Until the corrections pile up, "
            "put them in the prompt instead: overturn replay --examples 5",
            file=sys.stderr,
        )
        return 2
    rows = api.export(a.method, **params)
    print(f"exported {len(rows)} {a.method} rows ({json.dumps(stats.get('byKind', {}))})")
    result = train(
        rows,
        base_model=a.base,
        output_dir=a.out,
        method=a.method,
        epochs=a.epochs,
        lora_r=a.lora_r,
        learning_rate=a.learning_rate,
        max_seq_length=a.max_seq_length,
        merge=a.merge,
        backend=a.backend,
    )
    print(f"trained {result.base_model} ({result.backend}) in {result.seconds:.0f}s → {result.output_dir}")
    if a.register:
        filt: dict[str, Any] = {
            k: v for k, v in {"agent": a.agent, "tag": a.tag, "since": a.since}.items() if v
        }
        m = api.register(
            {
                "name": a.name,
                "baseModel": a.base,
                "servedAs": a.register,
                "method": a.method,
                "epochs": a.epochs,
                "filter": filt,
                "datasetStats": stats,
            }
        )
        gate: dict[str, Any] = m.get("gate") or {}
        raw_reasons: Any = gate.get("reasons") or []
        reasons: list[str] = [str(r) for r in cast(list[Any], raw_reasons)]
        verdict = (
            f", gate {'passed' if gate.get('pass') else 'failed'} ({'; '.join(reasons) or 'no regressions'})"
            if gate
            else ""
        )
        print(f"registered {m.get('name')} as {m.get('servedAs')}: status {m.get('status')}{verdict}")
        return 0 if m.get("status") in ("passed", "trained", "gating") else 1
    print(
        "serve the adapter on any OpenAI-compatible server, then: "
        f"overturn models register --base {a.base} --served-as local/<name>"
        + (f" --agent {a.agent}" if a.agent else "")
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    if a.cmd == "run":
        return cmd_run(a)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
