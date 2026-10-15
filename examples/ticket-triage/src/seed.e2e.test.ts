/**
 * End to end: fake model -> SDK -> real API -> Postgres. Needs TEST_DATABASE_URL
 * (defaults to the local overturn_test database) and the API package built.
 */
import { Overturn } from "@overturn/sdk";
import type { Page, Run, RunWithSteps } from "@overturn/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tickets } from "./data.js";
import { seed } from "./seed.js";

// The API is CommonJS; import its test harness through the built output.
const harness = await import("../../../apps/api/dist/test/harness.js");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;

beforeAll(async () => {
  ctx = await harness.startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

describe("ticket-triage seed", () => {
  it("records all 30 tickets as runs with their steps", async () => {
    const errors: string[] = [];
    const ov = new Overturn({
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      onError: (e) => errors.push(e.message),
    });
    const result = await seed(ov);
    await ov.shutdown();
    expect(errors).toEqual([]);
    expect(result.fake).toBe(true);
    expect(result.runIds).toHaveLength(30);

    const list = await harness.api<Page<Run>>(ctx, "GET", "/v1/runs?agent=ticket-triage&limit=100");
    expect(list.body.items).toHaveLength(30);
    expect(list.body.items.every((r) => r.status === "completed")).toBe(true);
    expect(list.body.items.every((r) => r.stepCount === 5)).toBe(true);

    const first = list.body.items.find((r) => r.externalId === "T-1001")!;
    const run = await harness.api<RunWithSteps>(ctx, "GET", `/v1/runs/${first.id}`);
    expect(run.body.input).toEqual(tickets[0]);
    expect(run.body.output).toMatchObject({ priority: "P0", team: "infrastructure" });
    expect(run.body.steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "tool_call:lookup_customer",
      "tool_call:search_kb",
      "llm_call:chat.completions",
      "tool_call:set_priority",
      "tool_call:assign_team",
    ]);
    const llm = run.body.steps[2]!;
    expect(llm.model).toBe("fake-triage-v1");
    expect((llm.input as { messages: unknown[] }).messages).toHaveLength(2);
    expect((llm.input as { response_format: unknown }).response_format).toBeDefined();
    expect(llm.params).toMatchObject({ temperature: 0 });
    expect(llm.usage?.inputTokens).toBeGreaterThan(0);
    expect(run.body.steps[3]!.sideEffect).toBe(true);
    expect(run.body.steps[0]!.sideEffect).toBe(false);
    expect(run.body.steps[0]!.fingerprint).toHaveLength(64);
  });
});
