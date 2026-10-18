import type { IngestPayload, Page, Run, RunWithSteps } from "@overturn-ai/shared";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, startTestApp, type TestContext } from "../test/harness";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

function payload(runId: string, stepIds: [string, string]): IngestPayload {
  const t0 = new Date("2026-10-15T10:00:00.000Z");
  return {
    v: 1,
    runs: [
      {
        id: runId,
        agent: "ticket-triage",
        agentVersion: "1.0.0",
        status: "running",
        input: { subject: "Outage" },
        tags: ["prod"],
        startedAt: t0.toISOString(),
      },
    ],
    steps: [
      {
        id: stepIds[0],
        runId,
        seq: 0,
        kind: "tool_call",
        name: "lookup_customer",
        input: { email: "a@b.c" },
        output: { plan: "enterprise" },
        sideEffect: false,
        fingerprint: "a".repeat(64),
        latencyMs: 12,
        startedAt: t0.toISOString(),
        endedAt: new Date(t0.getTime() + 12).toISOString(),
      },
      {
        id: stepIds[1],
        runId,
        seq: 1,
        kind: "llm_call",
        name: "chat.completions.create",
        model: "gpt-4.1-mini",
        provider: "openai",
        input: { messages: [{ role: "user", content: "hi" }] },
        output: { role: "assistant", content: "P1" },
        usage: { inputTokens: 10, outputTokens: 2 },
        costUsd: 0.0001,
        startedAt: new Date(t0.getTime() + 20).toISOString(),
      },
    ],
  };
}

describe("POST /v1/ingest", () => {
  it("rejects missing and bad keys", async () => {
    const noKey = await fetch(`${ctx.baseUrl}/v1/ingest`, { method: "POST" });
    expect(noKey.status).toBe(401);
    const bad = await api(ctx, "POST", "/v1/ingest", { v: 1 }, { authorization: "Bearer ov_live_nope" });
    expect(bad.status).toBe(401);
  });

  it("rejects unknown payload versions", async () => {
    const res = await api<{ message: string }>(ctx, "POST", "/v1/ingest", { v: 99, runs: [], steps: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/version/);
  });

  it("validates payloads", async () => {
    const res = await api<{ details: unknown[] }>(ctx, "POST", "/v1/ingest", {
      v: 1,
      runs: [{ id: "not-a-uuid", agent: "x", status: "running", startedAt: "nope" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("stores runs and steps and is idempotent", async () => {
    const runId = uuidv7();
    const stepIds: [string, string] = [uuidv7(), uuidv7()];
    const p = payload(runId, stepIds);
    const first = await api<{ runs: number; steps: number }>(ctx, "POST", "/v1/ingest", p);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ runs: 1, steps: 2 });

    // resend the same batch, then the run end
    await api(ctx, "POST", "/v1/ingest", p);
    const end = await api(ctx, "POST", "/v1/ingest", {
      v: 1,
      runs: [
        {
          id: runId,
          agent: "ticket-triage",
          status: "completed",
          output: { priority: "P1" },
          startedAt: p.runs[0]!.startedAt,
          endedAt: "2026-10-15T10:00:01.000Z",
        },
      ],
      steps: [{ ...p.steps[1]!, endedAt: "2026-10-15T10:00:00.900Z", latencyMs: 880 }],
    });
    expect(end.status).toBe(202);

    const got = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${runId}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("completed");
    expect(got.body.output).toEqual({ priority: "P1" });
    expect(got.body.input).toEqual({ subject: "Outage" });
    expect(got.body.tags).toEqual(["prod"]);
    expect(got.body.stepCount).toBe(2);
    expect(got.body.costUsd).toBeCloseTo(0.0001);
    expect(got.body.steps.map((s) => s.seq)).toEqual([0, 1]);
    expect(got.body.steps[1]!.latencyMs).toBe(880);
    expect(got.body.steps[0]!.fingerprint).toBe("a".repeat(64));
  });

  it("does not move a completed run back to running", async () => {
    const runId = uuidv7();
    const base = payload(runId, [uuidv7(), uuidv7()]).runs[0]!;
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [{ ...base, status: "completed" }], steps: [] });
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [{ ...base, status: "running" }], steps: [] });
    const got = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${runId}`);
    expect(got.body.status).toBe("completed");
  });

  it("accepts steps that arrive before their run", async () => {
    const runId = uuidv7();
    const p = payload(runId, [uuidv7(), uuidv7()]);
    const stepsOnly = await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [], steps: p.steps });
    expect(stepsOnly.status).toBe(202);
    const stub = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${runId}`);
    expect(stub.body.agent).toBe("unknown");
    expect(stub.body.stepCount).toBe(2);
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: p.runs, steps: [] });
    const filled = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${runId}`);
    expect(filled.body.agent).toBe("ticket-triage");
  });

  it("isolates projects", async () => {
    const runId = uuidv7();
    await api(ctx, "POST", "/v1/ingest", payload(runId, [uuidv7(), uuidv7()]));
    // a second project cannot see it
    const { bootstrap } = await import("../scripts/bootstrap");
    const other = await bootstrap(process.env.TEST_DATABASE_URL!, {
      email: "other@example.com",
      org: "Other",
      project: "other",
    });
    const res = await api(ctx, "GET", `/v1/runs/${runId}`, undefined, {
      authorization: `Bearer ${other.apiKey}`,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/runs", () => {
  it("filters and paginates", async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const [i, id] of ids.entries()) {
      const p = payload(id, [uuidv7(), uuidv7()]);
      p.runs[0]!.agent = i === 0 ? "other-agent" : "paginated";
      p.runs[0]!.startedAt = new Date(Date.parse("2026-10-16T00:00:00Z") + i * 1000).toISOString();
      await api(ctx, "POST", "/v1/ingest", p);
    }
    const page1 = await api<Page<Run>>(ctx, "GET", "/v1/runs?agent=paginated&limit=1");
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.items[0]!.id).toBe(ids[2]);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await api<Page<Run>>(
      ctx,
      "GET",
      `/v1/runs?agent=paginated&limit=1&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items[0]!.id).toBe(ids[1]);
    expect(page2.body.nextCursor).toBeNull();

    const tagged = await api<Page<Run>>(ctx, "GET", "/v1/runs?tag=prod&limit=200");
    expect(tagged.body.items.length).toBeGreaterThanOrEqual(3);
    const none = await api<Page<Run>>(ctx, "GET", "/v1/runs?tag=nope");
    expect(none.body.items).toHaveLength(0);
  });

  it("keeps list rows small: big input/output become size markers, detail keeps them", async () => {
    const id = uuidv7();
    const p = payload(id, [uuidv7(), uuidv7()]);
    p.runs[0]!.agent = "big-agent";
    p.runs[0]!.input = { blob: "x".repeat(20_000) };
    p.runs[0]!.output = { small: true };
    await api(ctx, "POST", "/v1/ingest", p);
    const list = await api<Page<Run>>(ctx, "GET", "/v1/runs?agent=big-agent");
    const row = list.body.items[0]!;
    expect((row.input as { $truncated?: number }).$truncated).toBeGreaterThan(8 * 1024);
    expect(row.output).toEqual({ small: true });
    const detail = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${id}`);
    expect((detail.body.input as { blob: string }).blob).toHaveLength(20_000);
  });

  it("GET /v1/me returns the project", async () => {
    const me = await api<{ project: { id: string }; keyPrefix: string }>(ctx, "GET", "/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.project.id).toBe(ctx.projectId);
    expect(me.body.keyPrefix.startsWith("ov_live_")).toBe(true);
  });
});

describe("GET /openapi.json", () => {
  it("documents every route with schemas from @overturn-ai/shared", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: unknown; responses: Record<string, unknown> }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
    expect(doc.paths["/v1/ingest"]!.post!.requestBody).toBeDefined();
    expect(doc.paths["/v1/replays/{id}/report"]!.get!.responses["200"]).toBeDefined();
  });
});

describe("CORS", () => {
  it("preflight allows the browser UI to DELETE and PATCH with credentials", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/api-keys/01a141aa-24c0-775f-b5e4-71b83af3ae56`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.overturn.run",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "x-overturn-project,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.overturn.run");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    for (const m of ["DELETE", "PATCH", "POST"]) expect(methods).toContain(m);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-overturn-project");
  });
});
