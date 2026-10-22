---
title: Hosted app
description: app.overturn.run — sign in, record your first run, correct it, replay it.
---

[app.overturn.run](https://app.overturn.run) is the hosted Overturn. Free during the beta.

## Sign in

Type your email; you get a link, no password. A new email creates a new workspace with one project. Invite teammates from **Settings → Members**: they see every project in the workspace.

## Record your first run

An empty project shows **Record your first run**:

1. **Create key.** Shown once; it is already filled into the snippet.
2. **Wrap your model client.** Pick TypeScript, Python or OpenTelemetry and copy the snippet. It sets `OVERTURN_API_KEY` and `OVERTURN_BASE_URL=https://api.overturn.run`.
3. **Run your agent once.** The page polls and turns into the run list when the first run lands.

No agent handy? The [quickstart](/docs/quickstart/) example records 30 support tickets and 20 corrections against a deterministic fake model; point it at the hosted API with the same two variables.

## Correct

Open a run, expand a model step, click **Correct**: approve, edit, reject or escalate, with a note. The dialog shows which fields the case will be scored on. Tick **One-off** for a correction that is evidence but not a rule: the case is kept but archived and left out of replays.

Corrections can also come from Slack (**Settings → Review webhook**: every completed run is posted with Review / Approve buttons), from your own product ([CorrectButton](/docs/correct-button/)), or from code (`ov.correct()`).

## Replay

**Replays → New replay.** Pick a model (or several, comma-separated), optionally a prompt version, and a filter over cases. The report lists regressions first. From a terminal, `overturn replay --model …` prints the same report and exits 1 on regressions, which is what the [GitHub Action](/docs/quickstart/#5-gate-pull-requests) uses.

## Models on the hosted instance

Replays run against whichever providers the hosted API has keys for; the model picker lists them. Judge-scored cases (reject, escalate, long text) use the project's judge model when its provider has a key, otherwise the cheapest configured model. Semantic matching needs an embedding provider; without one, `equals` falls back to exact comparison and says so in the report.

## Limits

Runs without a case are deleted after `retentionDays` (Settings, default 90). Runs behind a case are kept: they are the evidence. Rate limits are modest and per instance; if you need more, say so.
