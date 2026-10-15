# Decisions

One line of reasoning each. Newest at the bottom.

## 2026-10-15 (M1)

- **Client-generated UUID v7 ids for runs and steps; ingest is an idempotent upsert.** Lets the SDK batch and retry freely without duplicating rows, and lets steps arrive before the run ends.
- **Ingest payload carries `v: 1`; the API rejects unknown versions with 400 and keeps a `migrateIngest(v)` function as the upgrade path.** Cheapest versioning that still forces a conscious migration when the schema changes.
- **Canonical JSON for fingerprints: keys sorted recursively, `null`/`undefined` dropped, strings trimmed, numbers serialized as shortest round-trip with `-0 → 0` and integers without a fraction, arrays kept in order, nested objects canonicalized recursively.** Array order is semantic for most tool args (e.g. a list of ids to update), so it stays; everything else is normalized to stop spurious misses.
- **`matchOn` wins over `ignoreArgs` when both are set.** A whitelist is more predictable than a blacklist; `ignoreArgs` only applies when no `matchOn` is given.
- **Streaming responses in the wrappers are buffered and recorded as the final message; the step keeps `firstTokenMs` in `usage`.** Replay compares final outputs, and first-token latency is the only streaming fact worth keeping.
- **Tool steps are recorded with `sideEffect` from the tool declaration, default `false`.** The agent author knows; guessing from the name would be wrong often enough to be dangerous.
- **Postgres via postgres.js (`postgres`) + Drizzle, no ORM entities in NestJS.** Drizzle's SQL-shaped API keeps the schema readable in one file and migrations plain SQL.
- **Drizzle migrations are committed SQL and run by `pnpm db:migrate` at boot in docker-compose; the API never auto-migrates in production.** Explicit beats surprising.
- **API keys: `ov_live_` + 32 random bytes base62; stored as sha256; `prefix` keeps the first 12 chars for display.** Standard shape, no reversible storage.
- **The bootstrap script creates the first org/user/project/key from the terminal so M1–M5 work without the web app.** The UI is M6; nothing earlier should wait for it.
- **Validation with zod schemas from `@overturn/shared` through one Nest pipe; OpenAPI assembled from the same schemas via `z.toJSONSchema`.** One source of truth for payload shapes across API, SDKs and docs.
- **The example agent runs against a deterministic fake OpenAI-compatible server when `OPENAI_API_KEY` is unset.** Tests and keyless quickstarts stay reproducible; the README demo uses real models in CI.
- **pnpm + Turborepo, Biome instead of ESLint+Prettier.** One tool, fast, no config sprawl.
- **Versions pinned to the majors known to work together: NestJS 11, Next 15, TypeScript 5.9, Vercel AI SDK 5, zod 4, Vitest 3.** Newer majors exist (NestJS 12, Next 16, TS 7) but are not worth the migration risk in a 14-day build.
- **(superseded by the rename below) Package-name fallbacks for the `overrule` collision.**
- **Model keys never enter the build workspace; tests use the fake provider and real-model runs happen in GitHub Actions and Railway from secrets.** No secret store here, and the brief forbids keys in chat.
- **Renamed Overrule → Overturn (founder: "rename").** `overrule` was taken on npm and PyPI; `overturn` is free on both, so `npx overturn` and `pip install overturn` work and the metaphor survives. Packages: `overturn` (CLI), `@overturn/sdk`, `@overturn/shared` on npm; `overturn` on PyPI.

## 2026-10-16 (M2)

- **Python mirrors the TypeScript SDK name for name (`wrap_openai`, `@tool`, `ov.run()` as a context manager) and shares the fingerprint vectors file.** One contract, two implementations, one test fixture.
- **Python ingest runs on a daemon thread with a lock-protected queue; `flush()` drains from the caller's thread.** No asyncio dependency, works in sync and async agents.
- **`@tool` works at module level without a client reference: it records on the ambient run (contextvars) and reads the module-level replay state.** Matches how Python agents declare tools; `ov.tool(name, fn)` exists for the explicit style.
- **OTLP endpoint lives at the standard `/v1/traces` path (alias `/v1/otlp/v1/traces`) and accepts JSON and protobuf; protobuf is decoded with the generated root shipped in `@opentelemetry/otlp-transformer`.** Exporters work with just an endpoint and an `authorization` header; no vendored `.proto` files.
- **OTLP run id = trace id reshaped into a UUID; step id = sha256(traceId:spanId) reshaped.** Re-exports are idempotent and spans exported in separate requests land in the same run.
- **A batch without the trace's root span emits steps only; ingest stubs the run and the root's batch fills it in.** Guessing agent/tags from a child span clobbered the real values when requests arrived out of order.
- **`steps.seq` is bigint; OTLP uses the span start time in microseconds, SDKs count from 0.** Ordering must be stable across independently exported batches.
- **Ingest locks the touched run rows (`select … for update`) before inserting steps.** Concurrent batches for one run otherwise raced the `step_count` recount.
- **Supported GenAI attribute dialects: OTel GenAI semconv (`gen_ai.input.messages`, `gen_ai.tool.call.arguments`), OpenLLMetry (`gen_ai.prompt.N.*`, `traceloop.entity.*`), OpenInference (`llm.*`, `input.value`).** Covers the three instrumentations teams actually run.
- **Vercel AI SDK middleware records `generateText`/`streamText` as `ai.generate`/`ai.stream` steps with the AI SDK's own prompt shape as input.** Replay of these cases goes through the AI SDK too (M4), so no translation layer.

## 2026-10-17 (M3)

- **A run-level correction attaches to the run's last `llm_call` step and freezes that step; its original answer is the run output when present.** The last model call is the decision a human sees; the run output is what they corrected.
- **`originalOutput` and replay outputs are normalized through `extractAnswer()` (tool calls → `{tool_calls}`, JSON text → object, else string).** Humans correct answers, not provider envelopes; scorers compare answers.
- **Case size cap: frozen input ≤ 1 MB, keeping the system prompt plus the most recent messages and inserting a marker; tool recording outputs ≤ 256 KB each (string-truncated); `truncated = true` on the case.** Cases stay replayable in step mode and the UI shows the flag.
- **A correction on a run with no `llm_call` step is recorded but makes no case.** Nothing to replay; the correction still counts in the corrected-rate stat.
- **Case sets are saved filters merged under explicit query filters; `status` from the set wins only when the query left it at the default.** Keeps `--set regressions-q4 --agent x` intuitive.
- **Implicit approval runs hourly on pg-boss (`17 * * * *`), per project, `source = "implicit"`, `actor = "system"`, capped at 500 runs per sweep.** Cheap, idempotent (correction_count > 0 excludes a run), and the hourly jitter avoids the top-of-hour pile-up.
- **pg-boss lives in the `pgboss` schema of the same database; `JOBS_DISABLED=1` keeps it off in tests.** One Postgres, no Redis, as the brief asks.
- **The CLI bundles `@overturn/sdk` and `@overturn/shared` so `npx overturn` has no peer deps; it exports `defineConfig` for `overturn.config.ts`.** One install, one import.
- **`overturn init` writes `.env` (and warns when `.env` is not gitignored) rather than a JSON config with the key.** Keys live in `.env`, per the brief.

## 2026-10-18 (M4)

- **Step replay goes through the Vercel AI SDK `generateText` with the frozen messages converted to `ModelMessage[]`, tools as schema-only (no `execute`), `temperature: 0`, `seed: 42` where supported, and `response_format: json_schema` mapped to `Output.object`.** One call path for every provider; a model that stops at tool calls yields a tool decision to score.
- **The `fake/` provider is an OpenAI-compatible endpoint (`FAKE_OPENAI_URL`); its embedding model is a deterministic bag-of-words vector.** Keyless tests and demos stay reproducible and the code path is the real one.
- **Baseline = latest completed job for the case's recorded model with no prompt override; otherwise the recorded original output is scored with the same scorer.** Approve cases pass on the recorded baseline by construction, so any failure is a regression; edit cases fail by construction, so any pass is a fix.
- **Verdicts: `regression` / `fixed` only when the result flips against the baseline; otherwise `pass` / `fail`; `unchanged` is reserved for comparing two jobs; a reject case that now differs from the rejected output counts as `fixed`.** Keeps the report's three sections (regressions, still wrong, fixed) disjoint and literal.
- **Cost cap is checked before each case starts in a worker pool (not `Promise.all`); completed results are kept and the job finishes `completed` with `stoppedByCostCap`.** A cap that cancels in-flight calls would waste the spend it was meant to limit.
- **No estimate-vs-cap guard on job creation; the CLI shows the estimate and asks before a > $1 run without `--max-cost` or `-y`.** The cap is the hard limit; the estimate is advice.
- **Response cache lives in Postgres (`response_cache`, 24h TTL, purged hourly) keyed by model + canonical input hash + prompt override; judge and embedding calls are cached the same way.** No Redis; a rerun of the same job costs nothing.
- **Judge = `generateText` with the rubric prompt and a `{pass, reason}` JSON contract, project `judgeModel`, cached; falls back to a pass/fail regex if the model ignores the JSON contract.** Structured enough to be stable, loose enough for cheap models.
- **Prompt versions are stored templates; `--prompt name@version` replaces the first system message (or adds one) in step mode.** Lets a PR's prompt be replayed without re-recording.
- **Trajectory jobs are created with `mode: "trajectory"` and filled by `POST /v1/replays/:id/results` (scored server-side with the same scorers and baseline).** Only the customer's code can orchestrate the agent; scoring stays in one place.
- **Replay results `diff` stores `{expected, baseline, target}` so the report shows all three side by side without recomputation.** The report page is a read.

## 2026-10-19 (M5)

- **Replay state and the run context live on `globalThis` (`Symbol.for`), not in module scope.** The CLI bundles its own copy of the SDK; the customer's agent imports another. Both must see the same replay mode and the same ambient run.
- **In replay mode nothing is sent to the API: `emitRun` is a no-op and `emitStep` collects into the replay state.** Replay trajectories must never show up as production runs or corrupt the corrected-rate stat.
- **Trajectory model calls go through the server (`POST /v1/replays/model`) and the same cache, not to providers from the customer's machine.** Keys stay on the server, costs are counted once, and step and trajectory mode share one model path.
- **A refused side-effect tool ends the trajectory; the answer under test is the last model answer (or the refused call itself for `tool_choice` cases), recorded under `refusedSideEffects`.** The decision happened before the side effect; scoring it is the point, and the tool still never ran.
- **`overturn.config.ts` is loaded with jiti so it can import the agent's TypeScript directly; the runner wraps each case in an ambient run.** No build step for the customer; tools and wrapped clients record as they do in production.
- **The GitHub Action is composite (shell + `actions/github-script`), not a bundled JS action.** Nothing to compile or vendor; it runs `npx overturn` and upserts one marker-tagged comment per PR.
- **The repo's own replay gate records the base branch in a git worktree and replays the PR's prompt as `ticket-triage@pr`.** That is the real semantics of a prompt change: production cases vs the new prompt.

## 2026-10-20 (M6)

- **The web app authenticates with an httpOnly session cookie that the same `ApiKeyGuard` accepts, plus an optional `x-overturn-project` header.** One guard, one API; the UI proves the public API as the brief asks.
- **Magic links: 15-minute single-use tokens, sha256 at rest; without `RESEND_API_KEY` the API returns the link in the response and the login page shows it.** Self-hosters and tests work without an email provider; nothing is weaker in production.
- **First sign-in creates a personal workspace + `default` project; members are added by email and inherit every project in the workspace.** Minimal tenancy for v0.1 (no RBAC, as the brief says).
- **The browser reads the API URL from `/config` at runtime, not from a build-time `NEXT_PUBLIC_` value.** One web image works for docker-compose, Railway and tests on random ports.
- **shadcn-style primitives are hand-written (Button, Badge, Card, Input, Table, Dialog, Tabs on Radix) instead of generated by the shadcn CLI.** Same defaults, no registry fetch in the build, nine files.
- **The M6 acceptance test is a real browser (Playwright/Chromium) against the production Next build and the API harness.** The brief's "done when" is a user journey, so the test is one.
- **Docker images build from the monorepo root with pnpm filters; the API image runs migrations at boot; Railway uses the same Dockerfiles.** One build path for self-host and hosted.
- **Hosted deploy is a workflow gated on `vars.RAILWAY_DEPLOY == 'true'` + `RAILWAY_TOKEN`; nothing deploys until the founder sets them.** The build sandbox cannot reach Railway, and tokens never enter it.

## 2026-10-21 (M7)

- **The README quickstart is a CI job: `scripts/quickstart-check.sh` clones the repo fresh, runs every README command against a throwaway database and asserts the report has a regression and a fix.** "Works from the README alone" is a test, not a hope.
- **The README GIF is recorded by `apps/web/scripts/record-loop.mjs` in a real browser against the seeded example and assembled with Pillow.** Reproducible after UI changes; no hand-made screenshots to go stale.
- **Publishing is a manually run GitHub workflow that checks all four packages share one version, publishes to npm and PyPI, then tags `v<version>` and creates the release.** Tokens never enter the build workspace, the tag only exists once the packages do, and the build sandbox cannot push tags anyway.
- **Hosted domain: `overturn.run` (`api.overturn.run`, `app.overturn.run`) is the default base URL in both SDKs, the CLI and the Action.** Cheapest developer-coded TLD on offer and "run" is the product's noun; one constant to change if the founder picks another.
- **The example's `register-pr-prompt` script and the repo's replay gate stay in; the test PR that proves the gate is closed, not merged.** The gate must have failed once for real before v0.1 ships.
- **The API image reinstalls `--prod --offline` after building instead of `pnpm prune --prod`.** `pnpm prune` after a filtered install dropped `drizzle-orm`, so the first Railway deploy crashed at `migrate.js`; a prod reinstall from the warm store is deterministic.
- **`JobsService.start()` creates its pg-boss queues before `work()`/`schedule()`, and a test boots pg-boss for real.** pg-boss 10 refuses to schedule a queue that does not exist; every test ran with `JOBS_DISABLED=1`, so the first production boot was the first time the code path ran. Now it runs in CI.
