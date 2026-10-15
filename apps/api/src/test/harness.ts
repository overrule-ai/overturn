import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { bootstrap } from "../scripts/bootstrap";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/overturn_test";

export interface TestContext {
  app: NestFastifyApplication;
  baseUrl: string;
  apiKey: string;
  projectId: string;
  close: () => Promise<void>;
}

export async function truncateAll(): Promise<void> {
  const { sql } = createDb(TEST_DATABASE_URL, { max: 1 });
  try {
    await sql`truncate table organizations, users cascade`;
    await sql`truncate table response_cache`;
  } finally {
    await sql.end();
  }
}

export async function startTestApp(): Promise<TestContext> {
  await truncateAll();
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    PORT: "0",
    LOG_LEVEL: "warn",
  });
  const app = await createApp(config);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.getHttpServer().address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const boot = await bootstrap(TEST_DATABASE_URL, {
    email: "test@example.com",
    org: "Test",
    project: "test",
  });
  return {
    app,
    baseUrl,
    apiKey: boot.apiKey,
    projectId: boot.projectId,
    close: async () => {
      await app.close();
    },
  };
}

export async function api<T>(
  ctx: TestContext,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.apiKey}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}
