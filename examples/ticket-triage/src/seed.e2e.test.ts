/**
 * End to end: fake model -> SDK -> real API -> Postgres. Needs TEST_DATABASE_URL
 * (defaults to the local overturn_test database) and the API package built.
 */
import { Overturn } from "@overturn-ai/sdk";
import type { Page, Run, RunWithSteps } from "@overturn-ai/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tickets } from "./data.js";
import { seed } from "./seed.js";

// The API is CommonJS; import its test harness through the built output.
const harness = await import("../../../apps/api/dist/test/harness.js");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;
let fakeServer: { server: import("node:http").Server; url: string };

beforeAll(async () => {
  const { startFakeOpenAI } = await import("./fake-openai.js");
  fakeServer = await startFakeOpenAI(0);
  process.env.FAKE_OPENAI_URL = fakeServer.url; // the seed and the API's fake/ provider share it
  ctx = await harness.startTestApp();
});
afterAll(async () => {
  await ctx.close();
  fakeServer.server.close();
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

describe("the README demo", () => {
  it("replaying the weak model with the v2 prompt shows regressions and fixes", async () => {
    const ov = new Overturn({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
    const prompts = await ov.api.prompts.list("ticket-triage");
    expect(prompts.map((p) => p.version).sort()).toEqual(["v1", "v2", "weak"]);

    const created = await ov.api.replays.create({
      model: "fake/fake-triage-weak",
      promptVersion: "ticket-triage@v2",
      filter: { agent: "ticket-triage" },
    });
    expect(created.job.caseCount).toBe(20);
    let job = created.job;
    for (let i = 0; i < 200 && (job.status === "pending" || job.status === "running"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = await ov.api.replays.get(job.id);
    }
    expect(job.status).toBe("completed");
    const report = await ov.api.replays.report(job.id);
    // weak model demotes outages -> approved outage tickets from non-enterprise customers regress
    // (enterprise ones like T-1001 are rescued by the v2 bump, which is the point of the demo)
    expect(report.regressions.length).toBeGreaterThanOrEqual(1);
    expect(report.regressions.some((r) => r.title.includes("T-1020") || r.title.includes("T-1022"))).toBe(
      true,
    );
    expect(report.regressions.some((r) => r.title.includes("T-1001"))).toBe(false);
    // v2 prompt adds the enterprise bump -> some priority edits are fixed
    expect(report.fixed.length).toBeGreaterThanOrEqual(1);
    expect(report.fixed.some((r) => r.kind === "edit")).toBe(true);
    expect(job.summary!.completed).toBe(20);
    expect(job.summary!.baseline).toEqual({ kind: "recorded", jobId: null, model: "fake-triage-v1" });

    const { renderMarkdownReport } = await import("@overturn-ai/shared");
    const md = renderMarkdownReport(report);
    expect(md).toMatch(/### Regressions \([1-9]\d*\)/);
    expect(md).toMatch(/### Fixed \([1-9]\d*\)/);
    console.log(md.split("\n").slice(0, 4).join("\n"));

    // the same prompt with the good model: no regressions, fixes stay
    const good = await ov.api.replays.create({
      model: "fake/fake-triage-v1",
      promptVersion: "ticket-triage@v2",
      filter: { agent: "ticket-triage" },
    });
    let gj = good.job;
    for (let i = 0; i < 200 && (gj.status === "pending" || gj.status === "running"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      gj = await ov.api.replays.get(gj.id);
    }
    const goodReport = await ov.api.replays.report(gj.id);
    expect(goodReport.regressions).toHaveLength(0);
    expect(goodReport.fixed.length).toBeGreaterThanOrEqual(report.fixed.length);
  });
});

describe("trajectory replay through overturn.config.ts", () => {
  it("replays whole trajectories with tools answered from recordings and side effects refused", async () => {
    const { runTrajectory } = await import("overturn");
    const { ticketState } = await import("./tools.js");
    const ov = new Overturn({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
    const before = JSON.stringify([...ticketState.entries()]);
    const cwd = process.cwd();
    process.chdir(new URL("..", import.meta.url).pathname);
    let job: Awaited<ReturnType<typeof runTrajectory>>;
    try {
      job = await runTrajectory({
        api: ov.api,
        model: "fake/fake-triage-weak",
        promptVersion: "ticket-triage@v2",
        filter: { agent: "ticket-triage" },
        log: () => {},
      });
    } finally {
      process.chdir(cwd);
    }
    expect(job.status).toBe("completed");
    expect(job.mode).toBe("trajectory");
    expect(job.summary!.completed).toBe(20);
    // side-effect tools never ran: the in-memory ticket system is untouched
    expect(JSON.stringify([...ticketState.entries()])).toBe(before);
    const results = await ov.api.replays.results(job.id);
    const diffs = results.map(
      (r) =>
        r.diff as { refusedSideEffects: Array<{ toolName: string }> | null; steps: Array<{ name: string }> },
    );
    expect(diffs.every((d) => d.refusedSideEffects?.[0]?.toolName === "set_priority")).toBe(true);
    expect(
      diffs.every(
        (d) =>
          d.steps
            .map((s) => s.name)
            .slice(0, 3)
            .join(",") === "lookup_customer,search_kb,chat.completions",
      ),
    ).toBe(true);
    const report = await ov.api.replays.report(job.id);
    expect(report.regressions.length).toBeGreaterThanOrEqual(1);
    expect(report.fixed.length).toBeGreaterThanOrEqual(1);
    expect(report.unreplayable).toHaveLength(0);
  });
});
