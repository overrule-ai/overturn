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

describe("scripted corrections", () => {
  it("20 corrections produce 20 cases with the right expected", async () => {
    const { applyCorrections, planCorrections } = await import("./corrections.js");
    const ov = new Overturn({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
    const results = await applyCorrections(ov);
    expect(results).toHaveLength(20);
    expect(results.every((r) => r.case !== null)).toBe(true);
    const kinds = results.map((r) => r.correction.kind);
    expect(kinds.filter((k) => k === "edit")).toHaveLength(8);
    expect(kinds.filter((k) => k === "reject")).toHaveLength(2);
    expect(kinds.filter((k) => k === "approve")).toHaveLength(10);

    const plan = planCorrections();
    for (const [i, r] of results.entries()) {
      const c = r.case!;
      const p = plan[i]!;
      expect(c.agent).toBe("ticket-triage");
      expect(c.recordedModel).toBe("fake-triage-v1");
      expect(Object.keys(c.toolRecordings)).toHaveLength(4);
      expect(c.frozenInput.name).toBe("chat.completions");
      if (p.kind === "edit") {
        const original = c.originalOutput as { priority: string };
        const expected = c.expected as { priority: string };
        expect(c.scorer).toBe("json_match");
        expect(Number(expected.priority[1])).toBe(Math.max(0, Number(original.priority[1]) - 1));
      } else if (p.kind === "approve") {
        expect(c.scorer).toBe("json_match");
        expect(c.expected).toEqual(c.originalOutput);
      } else {
        expect(c.scorer).toBe("not_equals");
        expect(c.expected).toMatchObject({ not_equals: c.originalOutput, rubric: p.note });
      }
    }
    const list = await harness.api<Page<{ id: string }>>(
      ctx,
      "GET",
      "/v1/cases?agent=ticket-triage&limit=100",
    );
    expect(list.body.items).toHaveLength(20);
    const stats = await harness.api<{ corrected7d: number; runs7d: number }>(ctx, "GET", "/v1/runs/stats");
    expect(stats.body.runs7d).toBe(30);
    expect(stats.body.corrected7d).toBe(20);
  });
});
