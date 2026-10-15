#!/usr/bin/env bash
# Runs the README quickstart from a fresh clone against a throwaway database and
# checks that the replay report shows a regression. Used by CI (quickstart job) and
# by hand: DATABASE_URL=postgres://... pnpm quickstart:check
set -euo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
BASE_DB=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}
unset DATABASE_URL   # everything below must read the throwaway database from .env
DB_NAME="overturn_quickstart_$RANDOM"
DB_URL="${BASE_DB%/*}/$DB_NAME"
API_PORT=${API_PORT:-4321}
WEB_PORT=${WEB_PORT:-4323}
FAKE_PORT=${FAKE_PORT:-4322}
kill_port() { fuser -k -n tcp "$1" >/dev/null 2>&1 || true; }
cleanup() {
  kill_port "$API_PORT"; kill_port "$FAKE_PORT"; kill_port "$WEB_PORT"
  psql "$BASE_DB" -qc "drop database if exists $DB_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
START=$(date +%s)

step "clone"
git clone -q "$SRC" "$WORK/overturn"
cd "$WORK/overturn"
psql "$BASE_DB" -qc "create database $DB_NAME"

step "pnpm install && pnpm build"
pnpm install --frozen-lockfile --silent
pnpm build >/dev/null

step ".env + migrate + bootstrap"
cp .env.example .env
sed -i "s#^DATABASE_URL=.*#DATABASE_URL=$DB_URL#; s#^PORT=.*#PORT=$API_PORT#; s#^OVERTURN_BASE_URL=.*#OVERTURN_BASE_URL=http://127.0.0.1:$API_PORT#" .env
pnpm db:migrate >/dev/null
KEY=$(pnpm bootstrap --email you@example.com --json 2>/dev/null | tail -1 | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).apiKey))")
sed -i "s#^OVERTURN_API_KEY=.*#OVERTURN_API_KEY=$KEY#" .env
echo "FAKE_OPENAI_URL=http://127.0.0.1:$FAKE_PORT/v1" >> .env

step "start the API and the fake model"
(JOBS_DISABLED=1 LOG_LEVEL=warn pnpm --filter @overturn/api start >"$WORK/api.log" 2>&1 &)
(FAKE_OPENAI_PORT=$FAKE_PORT pnpm --filter @overturn/example-ticket-triage fake-openai >"$WORK/fake.log" 2>&1 &)
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || { cat "$WORK/api.log"; exit 1; }

step "start the web UI"
(OVERTURN_API_URL=http://127.0.0.1:$API_PORT pnpm --filter @overturn/web exec next start -p "$WEB_PORT" >"$WORK/web.log" 2>&1 &)
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$WEB_PORT/login" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$WEB_PORT/login" | grep -q "Overturn" || { cat "$WORK/web.log"; exit 1; }
curl -sf "http://127.0.0.1:$WEB_PORT/config" | grep -q "127.0.0.1:$API_PORT" || { echo "web /config does not point at the API"; exit 1; }

step "seed 30 runs, apply 20 corrections"
pnpm --filter @overturn/example-ticket-triage seed
pnpm --filter @overturn/example-ticket-triage corrections
npx overturn runs list --limit 3
npx overturn cases list --limit 3

step "replay against the weak model with the v2 prompt"
npx overturn replay --model fake/fake-triage-weak --prompt ticket-triage@v2 --format json --output "$WORK/report.json" -y
node -e "
const r=require('$WORK/report.json');
console.log('regressions', r.regressions.length, 'stillWrong', r.stillWrong.length, 'fixed', r.fixed.length);
if (r.regressions.length < 1 || r.fixed.length < 1) { console.error('expected at least one regression and one fix'); process.exit(1); }
"
npx overturn report "$(node -e "console.log(require('$WORK/report.json').job.id)")" --format md | head -8

END=$(date +%s)
step "quickstart OK in $((END-START))s"
