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
