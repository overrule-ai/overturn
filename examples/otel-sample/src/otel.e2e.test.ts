import type { Page, Run, RunWithSteps } from "@overturn/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeOtelAgent } from "./agent.js";
import { startTracing } from "./tracing.js";

const harness = await import("../../../apps/api/dist/test/harness.js");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;
beforeAll(async () => {
  ctx = await harness.startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

describe("OTel-instrumented agent", () => {
  it("shows up as runs with steps through /v1/traces", async () => {
    const provider = startTracing({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, simple: true });
    const triage = makeOtelAgent(provider.getTracer("test"));
    const out = await triage({
      id: "O-1",
      subject: "Site is down",
      body: "502",
      customerEmail: "rayfan@acme.com",
    });
    expect(out).toEqual({ priority: "P0", team: "infrastructure" });
    await provider.forceFlush();
    await provider.shutdown();

    const list = await harness.api<Page<Run>>(ctx, "GET", "/v1/runs?agent=ticket-triage");
    expect(list.body.items).toHaveLength(1);
    const run = await harness.api<RunWithSteps>(ctx, "GET", `/v1/runs/${list.body.items[0]!.id}`);
    expect(run.body).toMatchObject({
      status: "completed",
      agentVersion: "otel-1.0.0",
      externalId: "O-1",
      output: { priority: "P0", team: "infrastructure" },
      stepCount: 3,
    });
    expect(run.body.tags).toEqual(["otel-sample", "otel"]);
    expect(run.body.steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "tool_call:lookup_customer",
      "llm_call:chat",
      "tool_call:set_priority",
    ]);
    const llm = run.body.steps[1]!;
    expect(llm.model).toBe("fake-model-2026");
    expect(llm.usage).toMatchObject({ inputTokens: 42, outputTokens: 7 });
    expect((llm.input as { messages: unknown[] }).messages).toHaveLength(2);
    expect(run.body.steps[2]!.sideEffect).toBe(true);
    expect(run.body.steps[0]!.fingerprint).toHaveLength(64);
  });
});
