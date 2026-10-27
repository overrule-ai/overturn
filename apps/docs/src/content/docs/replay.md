---
title: "Replay: what it proves"
description: Recorded reality, refused side effects, and the receipt at the bottom of every report.
---

A replay re-runs the agent's decision-making against recorded reality. It does not re-run the world.

## Two modes

**Step mode** (default) replays the corrected model call: the exact prompt the agent sent, against the target model or prompt version. Fast and cheap; it answers "would this model have made the same decision here?".

**Trajectory mode** (`--mode trajectory`) re-runs your whole agent through `overturn.config.ts`, with every `ov.tool()` answered from the recording. Tool calls are matched by [fingerprint](/docs/fingerprint/) — the tool name plus the arguments you declared with `matchOn` — not by position, so a model that takes a different path still gets the right answers where they exist, and the trajectory stops where they don't.

## Side effects

Tools declared `sideEffect: true` are never executed in replay. A trajectory that reaches one is marked and stops there; the report counts it under **Blocked**. Nothing is emailed, refunded, or written twice.

## New paths

In trajectory mode the agent may call a tool in a way that was never recorded — the same lookup by a different key, a v2 endpoint, an extra check. That is not a failure yet; it is a **new path**, its own verdict in the report. The row shows the new call beside the recorded call(s) of the same tool. One click, **Accept as equivalent** (with an optional note), records the recorded output under the new call's fingerprint, so every future replay answers it, and lets the result stand under the human's original decision. If the tool was never called in the recording there is nothing to answer it from: correct the run with the new tool, or add it to the agent's recording.

New paths keep the CI gate red until someone accepts or rejects them (`overturn replay --fail-on-regression` exits 1; the GitHub Action fails). Turn that off per project in Settings ("New paths block the gate") or per run with `--allow-new-paths` / `allow-new-paths: true` if you would rather be told than blocked.

## Outcome contract

Decision fields say *what* the answer must contain. A contract says what must be *true* on every replay, in one or two hard rules a reviewer attaches while they still have the context — in the correction dialog, from `ov.correct({ contract })`, through `<CorrectButton>`, or later on the case page:

- `tool_called` — `never` call `refund`; call `lookup_customer` `once`; call `search_kb` `at_least_once`
- `answer` — must (or must not) contain `"P0"`; the whole answer is searched, field values included
- `tool_order` — `lookup_customer` before `refund`

Rules run after the scorer. A broken rule fails the case whatever the scorer said, is spelled out in the row ("contract: never call refund — called 1×"), and is a **regression** when the recorded run kept the rule. Keep contracts sparse: eight is the cap, one or two is the point.

## Suppress

A case that keeps failing for a reason nobody is going to fix is noise, and noise is how a gate gets ignored. **Suppress** on any report row (or the case page, or `cases.patch(id, { status: "suppressed" })`) takes the case out of the default suite. Suppressed cases stay counted on the cases list — the suite never shrinks silently — and come back with one click.

## The gate

Every report carries a verdict for CI: `gate.pass` is false on any regression, and on unaccepted new paths unless the project allows them. The CLI and the GitHub Action read that verdict; the PR comment says which.

## Readiness

Each run shows what its recording can prove: **replay-ready** (every tool call recorded or a refused side effect), **partially replayable** (some tool calls have no recorded output; trajectory replay stops at the first one, step replay still works) or **not replayable** (no model step with its prompt). OpenTelemetry traces that carry only tool names and arguments land in the second bucket; add the tool result on the span to make them full recordings.

## The receipt

Every report ends with a receipt: which model, prompt and mode were evaluated; how many tool answers were simulated from recordings; how many side effects were refused; what was not tested (live integrations, current external state); and the scorer's limits. A green check is only useful if you know exactly what green means.

## Scoring

The scorer is chosen from the shape of the expected answer: `tool_choice` for tool decisions, `json_match` for objects, `equals` for short text, `judge` for long text, `not_equals` / `should_escalate` for rejects and escalations. For objects that mix decision fields with prose, only the decision fields are scored, so a different model's phrasing is not a regression. Override per correction or per case.
