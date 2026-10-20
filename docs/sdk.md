# SDK reference

TypeScript (`@overturn-ai/sdk`) and Python (`overturn`) mirror each other name for name. Full API: `http://<api>/openapi.json`.

## Client

```ts
const ov = new Overturn({
  apiKey?: string,        // default OVERTURN_API_KEY
  baseUrl?: string,       // default OVERTURN_BASE_URL or https://api.overturn.run
  redact?: (step) => step | null,   // edit or drop a step before it is sent
  enabled?: boolean,      // false: record nothing (unit tests)
  debug?: boolean,        // or OVERTURN_DEBUG=1
  onError?: (err, { dropped, attempt }) => void,
  transport?: { flushIntervalMs?: 1000, maxBatchSize?: 100, maxQueueSize?: 10000, maxRetries?: 5 },
});
```

```python
ov = Overturn(api_key=None, base_url=None, *, redact=None, enabled=True, debug=None, on_error=None,
              flush_interval_s=1.0, max_batch_size=100)
```

Steps are batched and sent in the background. Failures retry with backoff (5xx, 408, 429), then the batch is dropped and `onError` is called. Recording never throws into your agent.

## Runs

```ts
const run = ov.startRun({ agent, version?, input?, tags?, metadata?, externalId?, id? });
await run.context(async () => { ... });   // AsyncLocalStorage: everything inside belongs to this run
run.step({ kind, name, input, output, ... }); // manual step (retrieval, human, …)
run.end({ output?, error? });
await ov.flush();                           // before the process exits
```

```python
with ov.run(agent, version=..., input=ticket, tags=[...]) as run:   # contextvars; also `async with`
    ...
    run.end(output=decision)   # on exception the run ends failed
ov.flush()
```

## Tools

```ts
const t = ov.tool("name", impl, { sideEffect?: false, matchOn?: ["key"], ignoreArgs?: ["ts"], description? });
await t(args);          // records a tool_call step with a fingerprint (docs/fingerprint.md)
t.fingerprint(args);
```

```python
@tool(side_effect=False, match_on=["email"], ignore_args=None, name=None)
def lookup_customer(email: str) -> dict: ...      # sync or async
lookup_customer.fingerprint("a@b.c")
ov.tool("name", fn, side_effect=True)             # explicit style
```

`sideEffect: true` marks tools that change the world. They are refused in replay, always.

## Model clients

| | TypeScript | Python |
|---|---|---|
| OpenAI chat completions (+ responses) | `ov.wrapOpenAI(client)` | `ov.wrap_openai(client)` (OpenAI and AsyncOpenAI) |
| Anthropic messages | `ov.wrapAnthropic(client)` | `ov.wrap_anthropic(client)` |
| Vercel AI SDK | `wrapLanguageModel({ model, middleware: ov.aiMiddleware() })` | — |

Streaming responses are buffered and recorded as the final message; `usage.firstTokenMs` keeps the first-token latency. The caller still receives every chunk.

Each call becomes an `llm_call` step with `input` = `{ messages, tools, tool_choice, response_format }` (or `{ system, messages, tools }` for Anthropic), `params` = the rest (temperature, max_tokens, …), `output` = `{ message, finish_reason }`, `usage`, `costUsd` (list prices, approximate).

## Corrections

```ts
const { correction, case } = await ov.correct({ runId, stepId?, kind: "approve" | "edit" | "reject" | "escalate", correctedOutput?, note?, actor? });
```

```python
ov.correct(run_id=..., step_id=None, kind="edit", corrected_output={...}, note=None, actor=None)
```

Sent immediately (not batched). `stepId` omitted = run-level correction (attached to the last model step). The case is returned.

**How the case is scored.** The scorer is picked from the shape of the expected answer: `tool_choice` for tool decisions, `json_match` for objects, `equals` (semantic fallback) for short text, `judge` for long text, `not_equals` / `should_escalate` for rejects and escalations. When an object mixes decision fields (short strings, numbers, booleans, lists of those) with prose, only the decision fields are scored (`scorerConfig.fields`, marked `auto: true`): a different model's phrasing is not a regression. Override per correction with `scorer` / `scorerConfig`, or later with `cases.patch`.

**One-offs.** A correction made for an unusual reason is evidence, not a rule. Tick **One-off** in the dialog (or `cases.patch(id, { status: "archived" })`): the correction and case are kept, but archived cases are left out of replays until restored.

**Corrections from your own UI.** The project key stays on the server: mount `ov.correctionHandler()` on a route and drop `<CorrectButton>` (from `@overturn-ai/sdk/react`, React ≥ 18, no other deps) next to the agent's answer.

```ts
// app/api/overturn/correct/route.ts (Next.js; any Request/Response runtime works)
export const POST = ov.correctionHandler({ actor: async (req) => (await getSession(req))?.email ?? null });
```

```tsx
import { CorrectButton } from "@overturn-ai/sdk/react";
<CorrectButton endpoint="/api/overturn/correct" runId={run.id} original={run.output} onDone={refresh} />
```

The button opens Approve / Edit / Reject / Escalate with a note; the handler validates the body, resolves the actor from your session (return a `Response` to refuse), and calls `ov.correct()`. Unstyled beyond sensible defaults; pass `className`/`style` or `kinds` to narrow the choices.

**Reviewing from Slack.** Set a Slack incoming-webhook URL in Settings → Project (`settings.reviewWebhookUrl`). Every completed run is posted once, with the input/output excerpt and two buttons: **Review** opens the run, **Approve** opens it with the approve dialog ready (the correction is written only when the human confirms). "Send test" posts a hello message; `POST /v1/project/webhook-test` does the same.

**Replay readiness.** The run page says what the recording can prove: *replay-ready* (every tool call recorded or a refused side effect), *partially replayable* (some tool calls have no recorded output: trajectory replay stops at the first one; step replay still works) or *not replayable* (no model step with its prompt). OpenTelemetry traces that only carry tool names and arguments land in the second bucket; add the tool result on the span (`gen_ai.tool.call.result`, `output.value` or `traceloop.entity.output`) to make them full recordings.

## Replay mode

```ts
const state = ov.replayMode(recordings, { allowSideEffects?: false, modelCall?, maxSteps?: 50 });
// every ov.tool() answers from `recordings[fingerprint].output`
// unseen fingerprint -> UnreplayableError; sideEffect tool -> SideEffectRefusedError; too many steps -> MaxStepsExceededError
state.calls   // what the agent tried
state.steps   // steps recorded while replaying (nothing is sent to the API)
ov.exitReplayMode();
```

```python
state = ov.replay_mode(recordings, allow_side_effects=False, model_call=None, max_steps=50)
ov.exit_replay_mode()
```

Replay state is process-global: your agent's own `Overturn` instances see it. `overturn replay --mode trajectory` sets it up for you from `overturn.config.ts`.

## REST client

`ov.api` is a thin client in both SDKs: `runs.list/get`, `cases.list/get/patch`, `corrections.create/list`, `replays.estimate/create/list/get/cancel/results/report/postResults`, `prompts.register/list`, `project.get/patch`, `me()`. TypeScript returns typed objects; Python returns plain dicts with the API's camelCase keys (`run["externalId"]`), and also offers flat methods (`ov.api.list_runs(...)`, `ov.api.get_case(id)`, `ov.api.replays.post_results(...)`).

## Redaction

```ts
new Overturn({ redact: (step) => step.name === "lookup_customer" ? { ...step, input: "[redacted]" } : step });
```

Return `null` to drop a step entirely. Applied before the step leaves the process.

## CLI

`npm i -g overturn-cli` (the command is `overturn`; `npx overturn-cli …` works too).

```
overturn init                                  # writes .env + overturn.config.ts, verifies the key
overturn runs list [--agent --tag --status --corrected --since 7d]   | runs get <id>
overturn cases list [--agent --kind --tag --set --status --since]    | cases get <id> | cases archive <id>
overturn replay --model provider/model[,provider/model…] [--mode step|trajectory] [--since 30d] [--agent] [--set] [--prompt name@version] [--max-cost 5] [--fail-on-regression 0] [--format table|json|md] [--output file]
overturn report <jobId> [--format md]
overturn replays list
overturn prompts register name@version <file> | prompts list
--json on any command prints JSON; --api-key / --base-url override the environment.
```

Several models at once (`--model a/x,b/y`) replay the same cases as one group and print a case × model matrix; `GET /v1/replays/groups/{groupId}` (`ov.api.replays.matrix(groupId)`) returns it, and the web app shows it at `/replays/groups/{groupId}`.

```
```
