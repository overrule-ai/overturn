# Overturn

**Every time a human corrects your agent, it becomes a test.**

Overturn records your agent's runs, turns human corrections into regression cases automatically, and replays them against any model with tools mocked, so nothing fires twice.

> Status: v0.1 in progress. Milestone 1 (record) is done; corrections, cases and replay land over the next two weeks. See [docs/plan.md](docs/plan.md).

## 60-second quickstart

```bash
git clone https://github.com/<owner>/overturn && cd overturn
pnpm install && pnpm build
cp .env.example .env                              # set DATABASE_URL to a Postgres 16 with pgvector
pnpm db:migrate
pnpm bootstrap --email you@example.com            # prints OVERTURN_API_KEY=ov_live_...
pnpm --filter @overturn/api start &               # API on :4000
OVERTURN_API_KEY=ov_live_... OVERTURN_BASE_URL=http://localhost:4000 \
  pnpm --filter @overturn/example-ticket-triage seed   # records 30 runs
curl -H "authorization: Bearer ov_live_..." localhost:4000/v1/runs | jq '.items[0]'
```

Without `OPENAI_API_KEY` the example runs against a deterministic fake model so everything above works offline.

## How it works

1. **Record.** `ov.wrapOpenAI(client)` turns every model call into an `llm_call` step; `ov.tool(name, fn, { sideEffect })` turns every tool invocation into a `tool_call` step with a fingerprint. Steps are batched and sent asynchronously; failures retry and never break your agent. OpenTelemetry GenAI traces are accepted too.
2. **Correct.** A human approves, edits, rejects or escalates from your app (`ov.correct()`), the Overturn UI, or `POST /v1/corrections`.
3. **Auto-case.** Each correction freezes the step's exact input, the run's tool recordings and the expected answer as a regression case.
4. **Replay.** `overturn replay --model anthropic/claude-sonnet-4-5 --since 30d` re-runs the cases with tools answered from the recording. Side-effect tools never execute.
5. **Report.** Regressions first, then still-wrong, then fixed, each with baseline, target and the human's correction side by side.
6. **CI gate.** The GitHub Action comments the report on PRs that touch prompts or agent code and fails on regressions.

## Record a run

```ts
import { Overturn } from "@overturn/sdk";
import OpenAI from "openai";

const ov = new Overturn({ apiKey: process.env.OVERTURN_API_KEY! });
const openai = ov.wrapOpenAI(new OpenAI());

const lookupCustomer = ov.tool("lookup_customer", lookupImpl, { sideEffect: false, matchOn: ["email"] });
const setPriority = ov.tool("set_priority", setPriorityImpl, { sideEffect: true });

const run = ov.startRun({ agent: "ticket-triage", version: "1.4.0", input: ticket, tags: ["prod"] });
await run.context(async () => {
  const customer = await lookupCustomer({ email: ticket.email });
  const decision = await openai.chat.completions.create({ model, messages, tools });
  await setPriority({ ticketId: ticket.id, priority: decision.priority });
  run.end({ output: decision });
});
await ov.flush();
```

## Self-hosting

One API (NestJS + Postgres 16 with pgvector), one web app. `docker-compose.yml` and a Railway template ship with milestone 6. Until then: `pnpm db:migrate` and `pnpm --filter @overturn/api start`.

## Docs

- [Plan](docs/plan.md) · [Decisions](docs/decisions.md) · [Fingerprint contract](docs/fingerprint.md)

## License

Apache-2.0
