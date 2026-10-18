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
overturn replay --model provider/model [--mode step|trajectory] [--since 30d] [--agent] [--set] [--prompt name@version] [--max-cost 5] [--fail-on-regression 0] [--format table|json|md] [--output file]
overturn report <jobId> [--format md]
overturn replays list
overturn prompts register name@version <file> | prompts list
--json on any command prints JSON; --api-key / --base-url override the environment.
```
