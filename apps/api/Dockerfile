# Overturn API — build from the monorepo root: docker build -f apps/api/Dockerfile .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @overturn/api... \
 && pnpm --filter @overturn/shared build \
 && pnpm --filter @overturn/api build \
 && rm -rf node_modules apps/api/node_modules packages/shared/node_modules \
 && pnpm install --frozen-lockfile --prod --offline --filter @overturn/api...

FROM node:22-slim AS runtime
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY --from=build /app ./
EXPOSE 4000
# Migrations run at boot (idempotent), then the API starts.
CMD ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/main.js"]
