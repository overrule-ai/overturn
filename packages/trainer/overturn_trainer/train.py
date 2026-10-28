"""LoRA fine-tuning on Overturn's export. The `trl` backend needs the `[train]` extra and a GPU
worth the name; the `dry` backend writes the dataset and a manifest and is what the tests run."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass
class TrainResult:
    backend: str
    base_model: str
    method: str
    rows: int
    epochs: int
    lora_r: int
    output_dir: str
    seconds: float
    merged: bool

    def manifest(self) -> dict[str, Any]:
        return asdict(self)


def write_dataset(rows: list[dict[str, Any]], output_dir: Path, method: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"train-{method}.jsonl"
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return path


def train(
    rows: list[dict[str, Any]],
    *,
    base_model: str,
    output_dir: str | Path,
    method: str = "sft",
    epochs: int = 3,
    lora_r: int = 16,
    learning_rate: float = 2e-4,
    max_seq_length: int = 4096,
    merge: bool = False,
    backend: str = "trl",
) -> TrainResult:
    """Fine-tune `base_model` on `rows` (Overturn's sft/dpo export) and save the adapter to `output_dir`."""
    out = Path(output_dir)
    t0 = time.time()
    dataset = write_dataset(rows, out, method)
    if backend == "dry":
        result = TrainResult(
            "dry", base_model, method, len(rows), epochs, lora_r, str(out), time.time() - t0, False
        )
    elif backend == "trl":
        from .trl_backend import train_trl

        train_trl(dataset, out, base_model, method, epochs, lora_r, learning_rate, max_seq_length, merge)
        result = TrainResult(
            "trl", base_model, method, len(rows), epochs, lora_r, str(out), time.time() - t0, merge
        )
    else:
        raise SystemExit(f"unknown backend {backend!r} (trl | dry)")
    (out / "overturn-manifest.json").write_text(json.dumps(result.manifest(), indent=2))
    return result
