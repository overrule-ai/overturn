---
title: Overturn
description: Every human correction of an AI agent becomes a replayable regression test.
---

Overturn records your agent's runs, turns every human correction into a replayable case, and replays those cases against any model or prompt with tools answered from the recording, so nothing fires twice. Open source, Apache-2.0, self-hosted on one Postgres or hosted at [app.overturn.run](https://app.overturn.run).

![Record a run, correct a step, get a case, replay it against another model, read the report](/loop.gif)

## The loop

1. **Record.** Wrap the model client you already have (`ov.wrapOpenAI`, `ov.wrapAnthropic`, the Vercel AI SDK middleware) or send OpenTelemetry spans. Every prompt, tool call and answer is stored with a fingerprint.
2. **Correct.** A human approves, edits, rejects or escalates: in the web app, in your own product with `<CorrectButton>`, from the Slack message each run posts, or via the API.
3. **Case.** Each correction freezes the step's exact input, the run's tool recordings and the expected answer, scored on the decision fields of the answer, not its prose.
4. **Replay.** `overturn replay --model anthropic/claude-sonnet-4-5` re-runs the cases with tools answered from the recording. Side-effect tools are refused, never executed. Comma-separate models for a case × model matrix.
5. **Report.** Regressions first, then still wrong, then fixed, each with baseline, target and the human's correction side by side, plus a receipt of what was and wasn't tested.

## Where to start

- Hosted and want to see it in ten minutes: [Hosted app](/docs/hosted/).
- Running your own: [Quickstart](/docs/quickstart/) and [Self-hosting](/docs/self-hosting/).
- Already recording: [SDK & CLI](/docs/sdk/).
