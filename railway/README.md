# Deploy Overturn on Railway

Two services from this repo plus a Postgres plugin. Railway builds each service from its Dockerfile.

1. Create a project, add **PostgreSQL** (the pgvector extension is created by the API's migrations on boot; Railway's Postgres image includes it).
2. Add service **api** from this repo: Settings → Build → Dockerfile path `apps/api/Dockerfile`, root `/`. Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `WEB_URL` = the web service's public URL (e.g. `https://overturn-web.up.railway.app`)
   - `AUTH_SECRET` = a long random string
   - `RESEND_API_KEY`, `EMAIL_FROM` (magic links), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, … (replay and judge)
   - Networking → generate a public domain on port 4000.
3. Add service **web** from this repo: Dockerfile path `apps/web/Dockerfile`. Variables:
   - `OVERTURN_API_URL` = the api service's public URL
   - Networking → public domain on port 3000.
4. Open the web URL, sign in with your email, create an API key in Settings, and point the SDK at the API URL.

`railway.json` in each app sets the Dockerfile path for the Railway CLI (`railway up --service api` from the repo root).

## CI deploy (optional)

`.github/workflows/deploy-railway.yml` deploys both services on every push to `main` when the `RAILWAY_TOKEN` secret is set. Create a project token in Railway (Project → Settings → Tokens) and add it as a repository secret; nothing deploys until it exists.
