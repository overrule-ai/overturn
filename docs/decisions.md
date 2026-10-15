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
