import { createServer, type Server } from "node:http";
import type { Project } from "@overturn-ai/shared";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, startTestApp, type TestContext } from "../test/harness";

let ctx: TestContext;
let hook: Server;
let hookUrl: string;
const received: Array<{ text: string; blocks: Array<Record<string, unknown>> }> = [];

beforeAll(async () => {
  ctx = await startTestApp();
  hook = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  const addr = hook.address();
  hookUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/hook`;
});
afterAll(async () => {
  await ctx.close();
  hook.close();
});

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function run(id: string, status: "running" | "completed") {
  return {
    id,
    agent: "ticket-triage",
    agentVersion: "1.2.0",
    status,
    input: { subject: "Outage <prod>" },
    output: status === "completed" ? { priority: "P1", team: "infra" } : undefined,
    tags: ["prod"],
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: status === "completed" ? "2026-10-15T10:00:01.000Z" : undefined,
  };
}

describe("review webhook", () => {
  it("is off until configured, then posts each completed run once with Review/Approve links", async () => {
    const silent = uuidv7();
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [run(silent, "completed")], steps: [] });
    const test = await api<{ ok: boolean; error?: string }>(ctx, "POST", "/v1/project/webhook-test");
    expect(test.body).toEqual({ ok: false, error: "no review webhook configured" });

    const patched = await api<Project>(ctx, "PATCH", "/v1/project", {
      settings: { reviewWebhookUrl: hookUrl },
    });
    expect(patched.body.settings.reviewWebhookUrl).toBe(hookUrl);
    const test2 = await api<{ ok: boolean; status?: number }>(ctx, "POST", "/v1/project/webhook-test");
    expect(test2.body).toEqual({ ok: true, status: 200 });
    await until(() => received.length === 1);
    expect(received[0]!.text).toMatch(/connected/);

    // a run still running is not posted; its completion is, exactly once
    const id = uuidv7();
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [run(id, "running")], steps: [] });
    await new Promise((r) => setTimeout(r, 150));
    expect(received.length).toBe(1);
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [run(id, "completed")], steps: [] });
    await until(() => received.length === 2);
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [run(id, "completed")], steps: [] });
    await new Promise((r) => setTimeout(r, 150));
    expect(received.length).toBe(2);

    const msg = received[1]!;
    expect(msg.text).toContain(`ticket-triage 1.2.0 completed`);
    expect(msg.text).toContain(`/runs/${id}`);
    const json = JSON.stringify(msg.blocks);
    expect(json).toContain("&lt;prod&gt;"); // mrkdwn-escaped input
    expect(json).toContain('\\"priority\\":\\"P1\\"');
    const actions = msg.blocks.find((b) => b.type === "actions") as { elements: Array<{ url: string }> };
    expect(actions.elements.map((e) => e.url)).toEqual([
      `http://localhost:3000/runs/${id}`,
      `http://localhost:3000/runs/${id}?approve=1`,
    ]);

    // the run that completed before the webhook existed is never back-filled
    await api(ctx, "POST", "/v1/ingest", { v: 1, runs: [run(silent, "completed")], steps: [] });
    await new Promise((r) => setTimeout(r, 150));
    expect(received.length).toBe(2);
  });

  it("rejects a non-URL", async () => {
    const res = await api(ctx, "PATCH", "/v1/project", { settings: { reviewWebhookUrl: "hooks.slack.com" } });
    expect(res.status).toBe(400);
  });
});
