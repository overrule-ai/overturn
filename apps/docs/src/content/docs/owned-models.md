---
title: "Owned models"
description: "Export, corrections in the prompt, challengers, train and gate, shadow, promote."
---


Capture and replay are open source and free. This is the part that turns the suite into leverage: use your corrections to make the model you run cheaper, or your own.

## The ladder

1. **Export.** `overturn export --format sft` (prompt → human-approved answer) or `--format dpo` (corrected vs the agent's original). Chat-format JSONL; Together, OpenAI and HF `trl` take it unchanged. Train anywhere — including your own cloud.
2. **Corrections in the prompt.** `ov.examples({ input, k: 5 })` returns the nearest human-approved cases and a block for your system prompt. Works with dozens of corrections, on the model you already pay for. Measure it first: `overturn replay --model <yours> --examples 5` and read the lift on the scorecard.
3. **Challenger scorecard.** `overturn replay --model <yours>,together/meta-llama/Llama-3.3-70B-Instruct-Turbo,…` replays the same cases against open-weight models and shows pass rate, regressions, cost per call and p50 latency next to the incumbent.
4. **Train and gate.** When the rows pile up (hundreds, for a narrow task), `overturn train --base meta-llama/Meta-Llama-3.1-8B-Instruct-Reference` fine-tunes a LoRA on Together, then replays the whole suite against the result. The gate is green only with no regressions, no unaccepted new paths, and a pass rate at or above the incumbent's.
5. **Shadow.** `overturn models shadow <id>`: the candidate answers every live run beside production, serving nothing. You see how often it agrees with production immediately and how often it matches the humans as corrections arrive.
6. **Promote — by hand.** `overturn models promote <id>`. `ov.promotedModel()` then returns its id for your router. Nothing is ever promoted automatically; automatic retraining is opt-in and comes later.

## Serving

Together serves a LoRA fine-tune from a dedicated endpoint, not serverless. After training, deploy the output model in Together (Models → your fine-tune → Deploy) and tell Overturn where it answers from: `overturn models serve <id> together/<endpoint model name>`. The gate re-runs against that endpoint. Weights are downloadable from Together for running in your own cloud or offline; the same export trains anywhere.

## Cost controls

Every replay — gate included — shows its estimate first and takes `--max-cost`. A challenger scorecard is one replay per model; the "New replay" page shows the total. Training is billed by Together per token; the model's row shows what it cost.

## Data

Training sends the exported rows (prompts, tool results, human answers) to Together under your key. Teams that cannot send traces to a third party: export and train in your own cloud, then `overturn models serve` the result anywhere Overturn can reach — the gate, shadow and promotion work the same. A managed in-your-cloud trainer is on the roadmap.
