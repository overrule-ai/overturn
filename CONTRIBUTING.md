# Contributing to Overturn

Thanks for helping. Overturn is a pnpm/Turborepo monorepo: `apps/api` (NestJS + Postgres), `apps/web` (Next.js), `apps/docs` (Astro + the landing page), `packages/sdk`, `packages/sdk-python`, `packages/cli`, `packages/trainer`, `packages/shared`.

## Setup

Node 22, pnpm 10, Postgres 16 with pgvector (`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16`), uv for the Python packages.

```bash
pnpm install && pnpm setup:python
cp .env.example .env
pnpm db:migrate
pnpm build
pnpm test
```

`pnpm lint` (Biome + ruff) and `pnpm typecheck` (tsc strict, pyright strict) must pass; CI runs the same commands. The API and web tests need the Postgres above; the web tests also need Chromium (`pnpm --filter @overturn-ai/web exec playwright install chromium`).

## Rules of the road

- TypeScript strict, no `any`. Python typed, pyright strict.
- Every feature ships with a test. Bug fixes ship with the test that would have caught them.
- Boring tech. Postgres is the only datastore; pg-boss is the only queue.
- Decisions that change how the product behaves get a line in `docs/decisions.md`; the plan lives in `docs/plan.md`.
- Secrets live in `.env`, in Railway and in GitHub Actions secrets. Never commit a key.

## Pull requests

Small and focused. Say what changed and why in the description; the diff says how. A maintainer reviews within a few days.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for vulnerabilities.
