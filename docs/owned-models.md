# Owned models

Capture and replay are open source and free. This is the part that turns the suite into leverage: use your corrections to make the model you run cheaper, or your own.

## The ladder

1. **Export.** `overturn export --format sft` (prompt → human-approved answer) or `--format dpo` (corrected vs the agent's original). Chat-format JSONL; Together, OpenAI and HF `trl` take it unchanged. Train anywhere — including your own cloud.
2. **Corrections in the prompt.** `ov.examples({ input, k: 5 })` returns the nearest human-approved cases and a block for your system prompt. Works with dozens of corrections, on the model you already pay for. Measure it first: `overturn replay --model <yours> --examples 5` and read the lift on the scorecard.
3. **Challenger scorecard.** `overturn replay --model <yours>,together/deepseek-ai/DeepSeek-V4.1-Flash,…` replays the same cases against open-weight models and shows pass rate, regressions, cost per call and p50 latency next to the incumbent.
4. **Train and gate.** When the rows pile up (hundreds, for a narrow task), `overturn train --base meta-llama/Meta-Llama-3.1-8B-Instruct-Reference` fine-tunes a LoRA on Together, then replays the whole suite against the result. The gate is green only with no regressions, no unaccepted new paths, and a pass rate at or above the incumbent's.
5. **Shadow.** `overturn models shadow <id>`: the candidate answers every live run beside production, serving nothing. You see how often it agrees with production immediately and how often it matches the humans as corrections arrive.
6. **Promote — by hand.** `overturn models promote <id>`. `ov.promotedModel()` then returns its id for your router. Nothing is ever promoted automatically; automatic retraining is opt-in and comes later.

## Serving

Together serves a LoRA fine-tune from a dedicated endpoint, not serverless. With `TOGETHER_PROJECT_ID` set on the server, Overturn creates that endpoint itself when training finishes — the base model on the cheapest certified hardware config, the LoRA attached as an adapter, one replica, auto-stop after an hour idle — and runs the gate when it is ready; `overturn models deploy <id> --dry-run` shows the plan first, and retiring the model deletes the endpoint (that is the bill). Without a project id, deploy the output model in Together yourself and tell Overturn where it answers from: `overturn models serve <id> together/<endpoint model name>`. The gate re-runs against that endpoint. Weights are downloadable from Together for running in your own cloud or offline; the same export trains anywhere.

## Cost controls

Every replay — gate included — shows its estimate first and takes `--max-cost`. A challenger scorecard is one replay per model; the "New replay" page shows the total. Training is billed by Together per token; the model's row shows what it cost.

## Data

Training sends the exported rows (prompts, tool results, human answers) to Together under your key. Teams that cannot send traces to a third party train in their own cloud with **`overturn-trainer`** (`pip install 'overturn-trainer[train]'`):

```bash
overturn-trainer run --base meta-llama/Llama-3.1-8B-Instruct --agent ticket-triage --out ./triage-lora
# serve ./triage-lora/adapter on vLLM (--enable-lora --lora-modules triage-lora=…), point the API at it with
# LOCAL_MODEL_BASE_URL, then register it (or pass --register local/triage-lora to the run):
overturn models register --base meta-llama/Llama-3.1-8B-Instruct --served-as local/triage-lora --agent ticket-triage
```

It pulls the same export, trains a LoRA with TRL/PEFT, and `POST /v1/models/register` puts the result through the same gate, shadow and promotion as a Together fine-tune. Only the export leaves Overturn; only the registration comes back. `local/<model>` is any OpenAI-compatible server (`LOCAL_MODEL_BASE_URL`), which is also how an air-gapped deployment replays.

## Continuous retraining (opt-in)

`overturn models auto --base meta-llama/Meta-Llama-3.1-8B-Instruct-Reference --min-new-rows 100` (or Settings → Continuous retraining). Every hour Overturn counts the training rows that arrived since the last automatic model; past the threshold it trains one, gates it against the suite, and — if it passes — turns shadow mode on so live evidence accrues. The review webhook hears when training starts and how the gate went. Nothing is promoted without a human: promotion stays a click, with the gate and the shadow numbers in front of you. `overturn models auto --off` stops it.
