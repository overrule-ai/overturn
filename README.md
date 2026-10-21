<p><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg"><img src="docs/assets/logo.svg" alt="Overturn" width="320"></picture></p>

**Every time a human corrects your agent, it becomes a test.**

Overturn records your agent's runs, turns every human correction into a replayable case, and replays those cases against any supported model or prompt with tools answered from the recording, so nothing fires twice. Open source, Apache-2.0, self-hosted on one Postgres.

![Record a run, correct a step, get a case, replay it against another model, read the report](docs/assets/loop.gif)

## 60-second quickstart

Needs Node 22, pnpm 10 and Postgres 16 with pgvector (`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16`).

```bash
git clone https://github.com/overrule-ai/overturn && cd overturn
pnpm install && pnpm build
cp .env.example .env                                  # DATABASE_URL -> your Postgres
pnpm db:migrate
pnpm bootstrap --email you@example.com                # prints OVERTURN_API_KEY=ov_live_... ; paste it into .env
pnpm --filter @overturn-ai/api start &                   # API on :4000 (magic links print here)
OVERTURN_API_URL=http://localhost:4000 pnpm --filter @overturn-ai/web start &   # UI on :3000
pnpm --filter @overturn-ai/example-ticket-triage seed    # the example agent triages 30 tickets -> 30 runs
pnpm --filter @overturn-ai/example-ticket-triage corrections   # 20 human corrections -> 20 cases
npx overturn replay --model fake/fake-triage-weak --prompt ticket-triage@v2 --format md
```

Open http://localhost:3000 to see the runs, click **Correct** on any model step, and watch the case appear. The last command replays all cases against a deliberately weaker model with a new prompt and prints regressions, still-wrong and fixed cases side by side with the human's correction. Without `OPENAI_API_KEY` the example runs on a deterministic fake model, so the whole loop works offline; with keys on the server try `--model openai/gpt-4.1-mini` or `--model anthropic/claude-haiku-4-5`, and `--mode trajectory` to re-run whole trajectories through your agent.

## How it works

1. **Record.** `ov.wrapOpenAI(client)` turns every model call into a step; `ov.tool(name, fn, { sideEffect })` turns every tool call into a fingerprinted step. Batched, retried, never throws into your agent. OpenTelemetry GenAI traces work too.
2. **Correct.** A human approves, edits, rejects or escalates: in the UI, in your own product with `<CorrectButton>` + `ov.correctionHandler()`, from your code with `ov.correct()`, via `POST /v1/corrections`, or from the Slack message each completed run posts (Review / Approve buttons).
3. **Auto-case.** Each correction freezes the step's exact input, the run's tool recordings and the expected answer as a regression case, scored on the decision fields of the answer, not its prose.
4. **Replay.** `overturn replay --model anthropic/claude-sonnet-4-5 --since 30d` re-runs the cases with every tool answered from the recording. Side-effect tools never execute. Comma-separate models for a case × model matrix.
5. **Report.** Regressions first, then still-wrong, then fixed, each with baseline, target and the human's correction.
6. **CI gate.** The [GitHub Action](packages/replay-action) comments the report on pull requests that touch prompts or agent code and fails on regressions.

Record in TypeScript (`@overturn-ai/sdk`), Python (`overturn`) or plain OpenTelemetry; the [quickstart](docs/quickstart.md) has the snippets.

## Self-hosting

One API (NestJS + Postgres 16 with pgvector), one web app, no Redis.

```bash
cp .env.example .env     # model keys for real replays; RESEND_API_KEY optional (links print in the API log without it)
docker compose up        # web on :3000, API on :4000
```

Sign in, create an API key in Settings, point the SDK at `http://localhost:4000`. Railway and the full variable list: [docs/self-hosting.md](docs/self-hosting.md).

## Docs

**Docs: [docs.overturn.run](https://docs.overturn.run)** · [SDK reference](docs/sdk.md) · [Quickstart](docs/quickstart.md) · [Fingerprint contract](docs/fingerprint.md) · [Self-hosting](docs/self-hosting.md) · [Decisions](docs/decisions.md)

## License

Apache-2.0
