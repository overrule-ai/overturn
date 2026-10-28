# pyright: basic
"""The TRL/PEFT backend: LoRA SFT or DPO on the export. Imported lazily; needs `overturn-trainer[train]`
and a GPU worth the name. Untyped third-party stack, hence the relaxed checker for this file only."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def train_trl(  # pragma: no cover - needs the ML stack and a GPU; exercised by hand, not in CI
    dataset: Path,
    out: Path,
    base_model: str,
    method: str,
    epochs: int,
    lora_r: int,
    learning_rate: float,
    max_seq_length: int,
    merge: bool,
) -> None:
    try:
        import torch  # type: ignore[import-not-found]
        from datasets import load_dataset  # type: ignore[import-not-found]
        from peft import LoraConfig  # type: ignore[import-not-found]
        from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore[import-not-found]
    except ImportError as err:
        raise SystemExit("the trl backend needs: pip install 'overturn-trainer[train]'") from err

    tokenizer: Any = AutoTokenizer.from_pretrained(base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model: Any = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto",
    )
    peft_config: Any = LoraConfig(
        r=lora_r,
        lora_alpha=lora_r * 2,
        lora_dropout=0.05,
        target_modules="all-linear",
        task_type="CAUSAL_LM",
    )
    data: Any = load_dataset("json", data_files=str(dataset), split="train")
    if method == "dpo":
        from trl import DPOConfig, DPOTrainer  # type: ignore[import-not-found]

        trainer: Any = DPOTrainer(
            model=model,
            args=DPOConfig(
                output_dir=str(out / "checkpoints"),
                num_train_epochs=epochs,
                learning_rate=learning_rate,
                beta=0.1,
                logging_steps=10,
                bf16=torch.cuda.is_available(),
                report_to=[],
            ),
            train_dataset=data,
            processing_class=tokenizer,
            peft_config=peft_config,
        )
    else:
        from trl import SFTConfig, SFTTrainer  # type: ignore[import-not-found]

        trainer = SFTTrainer(
            model=model,
            args=SFTConfig(
                output_dir=str(out / "checkpoints"),
                num_train_epochs=epochs,
                learning_rate=learning_rate,
                max_length=max_seq_length,
                logging_steps=10,
                bf16=torch.cuda.is_available(),
                report_to=[],
            ),
            train_dataset=data,
            processing_class=tokenizer,
            peft_config=peft_config,
        )
    trainer.train()
    trainer.save_model(str(out / "adapter"))
    tokenizer.save_pretrained(str(out / "adapter"))
    if merge:
        merged: Any = trainer.model.merge_and_unload()
        merged.save_pretrained(str(out / "merged"))
        tokenizer.save_pretrained(str(out / "merged"))
