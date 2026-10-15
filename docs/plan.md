# Overturn v0.1 plan

Fourteen days, seven milestones. A milestone is done when its tests pass, its part of the README quickstart works from a clean machine, CI is green, and the status report is sent.

Day 1 is 2026-10-15.

## M1 Record (days 1–2)

- [x] Monorepo: pnpm workspaces + Turborepo, Biome, TypeScript strict, shared tsconfig
- [x] `packages/shared`: ingest payload schemas (zod, `v: 1`), canonical JSON + fingerprint, shared types
- [x] `apps/api`: NestJS on Fastify, Drizzle schema for every table in the brief, migrations, pgvector
- [x] API keys (`ov_live_…`, sha256-hashed, shown once) and the bearer auth guard
- [x] `POST /v1/ingest` (idempotent upsert of runs and steps), `GET /v1/runs`, `GET /v1/runs/:id`, `GET /v1/me`
- [x] `bootstrap` script: org + user + project + first API key without the web UI
- [x] `packages/sdk`: `Overturn`, `startRun` + `run.context` (AsyncLocalStorage), `ov.tool()`, `wrapOpenAI`, batched async ingest with retry, `flush()`, `redact` hook
- [x] `examples/ticket-triage` (TypeScript): 30 synthetic tickets, four tools, seed script
- [x] Deterministic fake OpenAI server for keyless runs and tests
- [x] Tests: fingerprint, ingest, SDK batching/retry, example seed end to end against Postgres
- [x] CI: GitHub Actions with Postgres service, lint + typecheck + test
- [x] Push, status report

## M2 Ingest everywhere (days 3–4)

- [x] `packages/sdk-python`: `Overturn`, `run()` context manager, `@tool`, `wrap_openai`, `wrap_anthropic`, batched ingest, `flush()`, `redact`; pyright strict; pytest
- [x] `examples/ticket-triage/python` port recording the same runs
- [x] `POST /v1/traces` (+ `/v1/otlp/v1/traces`) OTLP/HTTP, JSON and protobuf, GenAI semantic-convention spans to runs and steps
- [x] `wrapAnthropic` in the TypeScript SDK; Vercel AI SDK middleware (`ov.aiMiddleware()`)
- [x] `examples/otel-sample`: OTel-instrumented agent that shows up as runs
- [x] Push, status report

## M3 Correct and case (days 5–6)

- [ ] `POST /v1/corrections` and `GET /v1/corrections`; SDK `correct()` in both SDKs
- [ ] Auto-case: freeze step input, run tool recordings, original output, `expected` by kind; size cap + truncation flag
- [ ] Default scorer selection from the shape of `expected`
- [ ] `implicitApproveAfterDays` sweeper (pg-boss scheduled job)
- [ ] `GET /v1/cases`, `PATCH /v1/cases/:id` (archive, retag, scorer), case sets
- [ ] CLI: `overturn init`, `runs list`, `cases list`
- [ ] Corrections script: 8 priority edits, 2 rejects, 10 approves → 20 cases with the right `expected`
- [ ] Push, status report

## M4 Step replay (days 7–9)

- [ ] Model access through the Vercel AI SDK (OpenAI, Anthropic, Google, OpenRouter), `provider/model` strings
- [ ] Scorers in `packages/shared`: `equals`, `json_match`, `tool_choice`, `semantic`, `judge`, `not_equals`, `should_escalate`
- [ ] Replay jobs on pg-boss: step mode, 24h response cache by `(model, input hash)`, per-provider concurrency and backoff
- [ ] Cost estimate before start, hard `--max-cost` cap that stops cleanly and keeps partial results
- [ ] Verdicts (`pass`, `fail`, `regression`, `fixed`, `unchanged`, `unreplayable`, `error`) and baseline rules
- [ ] `POST /v1/replays`, `GET /v1/replays/:id`, `GET /v1/replays/:id/report`
- [ ] CLI: `overturn replay`, `overturn report` (json, md)
- [ ] Demo: replay against a second model / weakened prompt variant shows ≥1 regression and ≥1 fix
- [ ] Push, status report

## M5 Trajectory replay and CI (days 10–11)

- [ ] SDK `replayMode(recordings)`: tools answered from recordings by fingerprint; unseen fingerprint → `unreplayable`; `sideEffect: true` refused outright. One test per guarantee.
- [ ] `overturn.config.ts` loader, trajectory mode in the CLI, `maxSteps`
- [ ] `packages/replay-action`: GitHub Action posting the markdown report as a PR comment, failing on `--fail-on-regression`
- [ ] Push, status report

## M6 Web UI and self-host (days 12–13)

- [ ] Next.js 15 app router, Tailwind, shadcn/ui, TanStack Query, public REST API only
- [ ] Pages: Runs, Run detail (timeline + Correct), Cases, Replays (new + progress + report), Settings
- [ ] Magic-link login through Resend, sessions, members
- [ ] `docker-compose.yml` (api, web, postgres), Railway template, hosted deploy
- [ ] Push, status report

## M7 Ship (day 14)

- [ ] Docs: quickstart, SDK reference, self-hosting, fingerprint contract, decisions
- [ ] README: headline, GIF, 60-second quickstart, six flows, self-hosting, SDK reference link, license
- [ ] Quickstart tested from a clean machine in under ten minutes
- [ ] `v0.1.0` tag, npm and PyPI publish
- [ ] Status report
