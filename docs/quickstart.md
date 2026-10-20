# Quickstart

Ten minutes from clone to a replay report that shows a regression. Needs Node 22, pnpm 10 and a Postgres 16 with the `vector` extension (Docker: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16`).

## 1. Install and start

```bash
git clone https://github.com/overrule-ai/overturn && cd overturn
pnpm install && pnpm build
cp .env.example .env                 # DATABASE_URL points at your Postgres
pnpm db:migrate
pnpm bootstrap --email you@example.com
#   -> OVERTURN_API_KEY=ov_live_...   (paste it into .env)
pnpm --filter @overturn-ai/api start &   # API on http://localhost:4000
```

Or `docker compose up` and create the key in the web UI (http://localhost:3000 → Settings).

## 2. Record runs

The reference agent triages 30 support tickets. Without `OPENAI_API_KEY` it runs against a deterministic fake model, so the whole loop works offline.

```bash
pnpm --filter @overturn-ai/example-ticket-triage seed
npx overturn runs list
```

In your own agent:

```ts
import { Overturn } from "@overturn-ai/sdk";
import OpenAI from "openai";

const ov = new Overturn();                      // reads OVERTURN_API_KEY / OVERTURN_BASE_URL
const openai = ov.wrapOpenAI(new OpenAI());     // every call -> llm_call step
const lookup = ov.tool("lookup_customer", lookupImpl, { sideEffect: false, matchOn: ["email"] });
const setPriority = ov.tool("set_priority", setPriorityImpl, { sideEffect: true });

const run = ov.startRun({ agent: "ticket-triage", version: "1.4.0", input: ticket, tags: ["prod"] });
await run.context(async () => {
  const customer = await lookup({ email: ticket.email });
  const decision = await openai.chat.completions.create({ model, messages });
  await setPriority({ ticketId: ticket.id, priority: decision.priority });
  run.end({ output: decision });
});
await ov.flush();
```

Python (`pip install overturn`):

```python
from overturn import Overturn, tool
ov = Overturn()
client = ov.wrap_openai(OpenAI())

@tool(side_effect=False, match_on=["email"])
def lookup_customer(email: str) -> dict: ...

with ov.run(agent="ticket-triage", version="1.4.0", input=ticket) as run:
    ...
    run.end(output=decision)
```

Already tracing with OpenTelemetry? Point the exporter at `http://localhost:4000/v1/traces` with header `authorization=Bearer ov_live_…`; GenAI-semconv spans become steps.

## 3. Correct

Open http://localhost:3000, pick a run, click **Correct** on a model step (approve / edit / reject / escalate). From your own app:

```ts
await ov.correct({ runId, stepId, kind: "edit", correctedOutput: { priority: "P1" }, note: "Enterprise customer", actor: "rayfan@acme.com" });
```

Or apply the scripted 20 corrections to the example: `pnpm --filter @overturn-ai/example-ticket-triage corrections`.

Every correction is a case: `npx overturn cases list`.

## 4. Replay

```bash
npx overturn replay --model fake/fake-triage-weak --prompt ticket-triage@v2 --format md
```

Regressions first (approved cases that now fail), then still-wrong, then fixed, each with baseline, target and the human correction side by side. Compare models in one go with `--model fake/fake-triage-v1,fake/fake-triage-weak` (a case × model matrix). With keys on the server: `--model openai/gpt-4.1-mini`, `--model anthropic/claude-haiku-4-5`, `--model google/gemini-2.5-flash`, `--model openrouter/<model>`.

Whole trajectories through your agent, tools answered from the recording: `npx overturn init` (writes `overturn.config.ts`), implement `agent()`, then `npx overturn replay --mode trajectory --model …`.

## 5. Gate pull requests

```yaml
- uses: overrule-ai/overturn/packages/replay-action@main
  with:
    api-key: ${{ secrets.OVERTURN_API_KEY }}
    model: openai/gpt-4.1-mini
    fail-on-regression: 0
```

The report lands as a PR comment; the check fails on regressions. See [packages/replay-action](../packages/replay-action/README.md).
