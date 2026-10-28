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

- [x] `POST /v1/corrections` and `GET /v1/corrections`; SDK `correct()` in both SDKs; typed `ov.api` client
- [x] Auto-case: freeze step input, run tool recordings, original output, `expected` by kind; size cap + truncation flag
- [x] Default scorer selection from the shape of `expected`
- [x] `implicitApproveAfterDays` sweeper (pg-boss scheduled job, hourly)
- [x] retention job (daily): case-less runs past `retentionDays` deleted
- [x] `GET /v1/cases`, `GET /v1/cases/:id`, `PATCH /v1/cases/:id` (archive, retag, scorer, expected), case sets, `GET/PATCH /v1/project`
- [x] CLI (`overturn` on npm): `init`, `runs list|get`, `cases list|get|archive`
- [x] Corrections script: 8 priority edits, 2 rejects, 10 approves → 20 cases with the right `expected`
- [x] Push, status report

## M4 Step replay (days 7–9)

- [x] Model access through the Vercel AI SDK (OpenAI, Anthropic, Google, OpenRouter) plus a `fake/` OpenAI-compatible provider for keyless runs; `provider/model` strings
- [x] Scorers in `packages/shared`: `equals` (semantic fallback), `json_match` (JSONPath fields/ignore), `tool_choice`, `semantic`, `judge`, `not_equals`, `should_escalate`
- [x] Replay jobs on pg-boss: step mode, worker pool with per-provider concurrency, rate-limit backoff, 24h response cache by `(model, input hash)`
- [x] Cost estimate before start (`POST /v1/replays/estimate`), hard `--max-cost` cap that stops cleanly and keeps partial results
- [x] Verdicts (`pass`, `fail`, `regression`, `fixed`, `unreplayable`, `error`) and baseline rules (latest completed job for the recorded model, else the recorded outputs)
- [x] Prompt versions (`POST /v1/prompts`, `--prompt name@version` swaps the system prompt in step mode)
- [x] `POST /v1/replays`, `GET /v1/replays[/:id]`, `/results`, `/report` (JSON) and `/report.md`, `/cancel`; `POST /v1/replays/:id/results` for trajectory runners
- [x] CLI: `overturn replay` (estimate, progress, table/json/md, `--fail-on-regression`), `report`, `replays list`, `prompts register|list`
- [x] Demo: `fake/fake-triage-weak` with `ticket-triage@v2` over the 20 cases shows 2 regressions, 7 fixed, 3 still wrong (e2e tested)
- [x] Push, status report

## M5 Trajectory replay and CI (days 10–11)

- [x] SDK `replayMode(recordings, { modelCall, maxSteps })` in TS and Python: tools answered from recordings by fingerprint; unseen fingerprint → `UnreplayableError`; `sideEffect: true` refused outright; model calls swapped for the target through `POST /v1/replays/model`; steps collected locally, nothing recorded. Replay state and run context are process-global so the customer's own SDK copy sees them.
- [x] `overturn.config.ts` loader (jiti), trajectory mode in the CLI (`--mode trajectory`), `maxSteps`, batched result posting; the first refused side-effect tool ends the trajectory and the decision before it is scored
- [x] `packages/replay-action`: composite GitHub Action — replay, markdown report in the job summary, upserted PR comment, failing check on `fail-on-regression`
- [x] `.github/workflows/replay-gate.yml`: self-test on PRs touching the example prompt (base branch recorded, PR prompt registered as `ticket-triage@pr`, replayed with the fake provider)
- [x] Push, status report

## M6 Web UI and self-host (days 12–13)

- [x] Next.js 15 app router, Tailwind v4, shadcn-style primitives, TanStack Query; talks to the API only through the public REST API (session cookie or API key)
- [x] Pages: Runs (corrected rate 7d, last replay pass rate, filters), Run detail (timeline with expandable I/O, Correct on every llm_call step and on the run: approve / edit / reject / escalate + note), Cases (list, detail with frozen input, expected, tool recordings, result history; archive, retag, scorer), Replays (new with estimate, progress, report with regressions / still wrong / fixed side by side with the human correction), Settings (API keys shown once, project settings, members)
- [x] Magic-link login through Resend (dev mode returns the link), sessions, members; `x-overturn-project` project switcher
- [x] Playwright acceptance test: a new user signs in, sees runs, corrects a step, launches a replay, reads the report, mints a key
- [x] `docker-compose.yml` (api, web, postgres), Dockerfiles, Railway config + README, optional Railway deploy workflow
- [x] Push, status report

## M7 Ship (day 14)

- [x] Docs: quickstart, SDK reference, self-hosting, fingerprint contract, decisions
- [x] README: headline, GIF, 60-second quickstart, six flows, self-hosting, SDK reference link, license
- [x] Quickstart tested from a fresh clone in under ten minutes (`scripts/quickstart-check.sh`, also a CI job)
- [x] Release workflow (manual run) publishes to npm and PyPI, then tags `v0.1.0`; waits on `NPM_TOKEN` / `PYPI_TOKEN`
- [x] Status report

## Onboarding-ready (Oct 20)

What a stranger gets today: app.overturn.run → email link → fresh workspace → "Record your first run" panel (key, TS/Python/OTel snippet with the key in it, polls for the first run) → run list → Correct → case → Replay → report. Judge scoring works on the hosted instance with the Anthropic key alone (fallback), semantic scoring needs an OpenAI key.

- [x] real sign-in email (Resend, overturn.run verified), rate-limited
- [x] first-run onboarding panel + e2e for a brand-new workspace
- [x] judge model fallback to any configured provider
- [x] hosted smoke test green after every deploy
- [ ] `OPENAI_API_KEY` on Railway for the semantic scorer (optional)
- [ ] terms/privacy pages (needed before any paid tier, not before a free beta)
- [ ] first outside user: Fluorine wired in for a week

## Trust the gate (Oct 26)

A gate that fails on a valid new path, or that nobody can quiet, gets bypassed. Milestone from the product review:

- [x] `new_path` verdict for tool calls with no recording; side-by-side with the recorded calls; "Accept as equivalent" records the fingerprint and lets the result stand (`POST /v1/cases/:id/equivalents`)
- [x] new paths block the gate until accepted; per-project toggle, `--allow-new-paths`, Action input
- [x] outcome contract on cases (tool never / once / at least once, answer contains, tool order), set in the dialog, SDKs and CorrectButton, edited on the case page; violations are regressions
- [x] suppress from any report row; counts on the cases list; one-click restore
- [x] `gate` on every report; CLI, Action and web read it
- [ ] auto-suggest case title and tags from the run
- [x] suite hygiene: duplicate corrections merge into one case (×N), `cases dedupe` for older ones
- [ ] suite hygiene: cluster similar cases, "hasn't failed in 90 days" nudge, priority weighting
- [x] "what changed" narrative (report, PR comment, CLI, web) and per-row latency
- [ ] replay audit log


## Owned models (Oct 27 →)

Capture and replay stay open source. Training, gating, hosting and retraining are the cloud product.

- [x] export: `overturn export --format sft|dpo`, `GET /v1/export`
- [x] challenger scorecard: Together provider, cost/call + p50 latency in summaries, scorecard on the matrix, one-click challengers
- [x] corrections in the prompt: `GET /v1/examples`, `ov.examples()`, `replay --examples k`, lift on the scorecard
- [x] train and gate: `overturn train`, Together LoRA fine-tune → gate replay (no regressions, no new paths, pass rate ≥ incumbent) → shadow on live runs → promote by hand; `ov.promotedModel()`
- [ ] serving: create the Together dedicated endpoint from Overturn (today the user deploys it and runs `models serve`)
- [ ] training in the customer's cloud: a managed trainer; today it is export + train anywhere + `models serve`
- [ ] continuous retraining (opt-in): new corrections past a threshold or a new base model → retrain → gate → shadow → notify
