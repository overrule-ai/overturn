# Self-hosting

Overturn is one API service (NestJS, Node 22) and one web app (Next.js) on Postgres 16 with pgvector. Background jobs (replay, implicit approval, cache purge) run on pg-boss inside the API process. No Redis, no queues to operate.

## docker compose

```bash
cp .env.example .env
docker compose up -d
open http://localhost:3000
```

The API runs migrations at boot. Sign in with your email: without `RESEND_API_KEY` the magic link is printed in the API log (`docker compose logs api`) and shown on the login page.

## Environment

| Variable | Service | Purpose |
|---|---|---|
| `DATABASE_URL` | api | Postgres 16 with `CREATE EXTENSION vector` allowed |
| `PORT` | api | default 4000 |
| `WEB_URL` | api | public URL of the web app, used in magic links and cookie settings |
| `AUTH_SECRET` | api | any long random string |
| `RESEND_API_KEY`, `EMAIL_FROM` | api | magic-link email; optional in dev |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY` | api | replay targets and the judge/embedding models |
| `JOBS_DISABLED` | api | `1` to run without pg-boss (replays then run inline in the request process) |
| `LOG_LEVEL` | api | fatal … trace |
| `OVERTURN_API_URL` | web | the URL the **browser** uses to reach the API (read at runtime) |

Cookies: when `WEB_URL` is `https://…`, the session cookie is `Secure; SameSite=None` so the web app and API can live on different hosts. Put both behind one domain (`app.example.com` and `api.example.com`) or the same reverse proxy.

## Railway

See [railway/README.md](../railway/README.md): a Postgres plugin plus two services built from `apps/api/Dockerfile` and `apps/web/Dockerfile`. A deploy workflow (`.github/workflows/deploy-railway.yml`) ships `main` when `RAILWAY_TOKEN` and the `RAILWAY_DEPLOY=true` variable are set.

## Without Docker

```bash
pnpm install && pnpm build
pnpm db:migrate
pnpm --filter @overturn-ai/api start          # node apps/api/dist/main.js
OVERTURN_API_URL=http://localhost:4000 pnpm --filter @overturn-ai/web start
```

## Operations

- **Migrations** are plain SQL in `apps/api/drizzle/`, applied by `pnpm db:migrate` (or at container boot). Never auto-applied by the running API.
- **Retention**: `retentionDays` in project settings is stored for v0.2's cleanup job; v0.1 keeps everything.
- **Cache**: model responses for replay live in `response_cache` (24h TTL, purged hourly).
- **Backups**: it is one Postgres database; `pg_dump` is the whole story.
- **Scaling**: the API is stateless apart from pg-boss, which coordinates through Postgres; run several replicas behind a load balancer if needed.
