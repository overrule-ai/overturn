---
title: "Replay: what it proves"
description: Recorded reality, refused side effects, and the receipt at the bottom of every report.
---

A replay re-runs the agent's decision-making against recorded reality. It does not re-run the world.

## Two modes

**Step mode** (default) replays the corrected model call: the exact prompt the agent sent, against the target model or prompt version. Fast and cheap; it answers "would this model have made the same decision here?".

**Trajectory mode** (`--mode trajectory`) re-runs your whole agent through `overturn.config.ts`, with every `ov.tool()` answered from the recording. Tool calls are matched by [fingerprint](/fingerprint/) — the tool name plus the arguments you declared with `matchOn` — not by position, so a model that takes a different path still gets the right answers where they exist, and the trajectory stops where they don't.

## Side effects

Tools declared `sideEffect: true` are never executed in replay. A trajectory that reaches one is marked and stops there; the report counts it under **Blocked**. Nothing is emailed, refunded, or written twice.

## Readiness

Each run shows what its recording can prove: **replay-ready** (every tool call recorded or a refused side effect), **partially replayable** (some tool calls have no recorded output; trajectory replay stops at the first one, step replay still works) or **not replayable** (no model step with its prompt). OpenTelemetry traces that carry only tool names and arguments land in the second bucket; add the tool result on the span to make them full recordings.

## The receipt

Every report ends with a receipt: which model, prompt and mode were evaluated; how many tool answers were simulated from recordings; how many side effects were refused; what was not tested (live integrations, current external state); and the scorer's limits. A green check is only useful if you know exactly what green means.

## Scoring

The scorer is chosen from the shape of the expected answer: `tool_choice` for tool decisions, `json_match` for objects, `equals` for short text, `judge` for long text, `not_equals` / `should_escalate` for rejects and escalations. For objects that mix decision fields with prose, only the decision fields are scored, so a different model's phrasing is not a regression. Override per correction or per case.
