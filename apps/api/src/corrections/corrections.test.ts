import type {
  Case,
  CaseSet,
  CaseSummary,
  CorrectionResult,
  IngestPayload,
  Page,
  Project,
  RunWithSteps,
} from "@overturn-ai/shared";
import { toolFingerprint } from "@overturn-ai/shared";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, startTestApp, type TestContext } from "../test/harness";
import { FROZEN_INPUT_MAX_BYTES, truncateFrozenInput } from "./corrections.service";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

/** A recorded triage run: lookup -> llm (JSON decision) -> set_priority. */
async function recordRun(
  opts: { agent?: string; externalId?: string; tags?: string[]; priority?: string; endedAt?: string } = {},
) {
  const runId = uuidv7();
  const lookupId = uuidv7();
  const llmId = uuidv7();
  const setId = uuidv7();
  const t0 = "2026-10-15T10:00:00.000Z";
  const decision = { priority: opts.priority ?? "P2", team: "billing", reply: "Hi" };
  const payload: IngestPayload = {
    v: 1,
    runs: [
      {
        id: runId,
        agent: opts.agent ?? "ticket-triage",
        agentVersion: "1.0.0",
        externalId: opts.externalId ?? "T-1",
        status: "completed",
        input: { id: "T-1", subject: "Duplicate charge" },
        output: decision,
        tags: opts.tags ?? ["prod"],
        startedAt: t0,
        endedAt: opts.endedAt ?? "2026-10-15T10:00:01.000Z",
      },
    ],
    steps: [
      {
        id: lookupId,
        runId,
        seq: 0,
        kind: "tool_call",
        name: "lookup_customer",
        input: { email: "a@b.c" },
        output: { plan: "enterprise" },
        fingerprint: toolFingerprint("lookup_customer", { email: "a@b.c" }),
        startedAt: t0,
      },
      {
        id: llmId,
        runId,
        seq: 1,
        kind: "llm_call",
        name: "chat.completions",
        model: "fake-triage-v1",
        provider: "openai",
        input: {
          messages: [
            { role: "system", content: "triage" },
            { role: "user", content: "{}" },
          ],
          response_format: { type: "json_schema" },
        },
        params: { temperature: 0 },
        output: { message: { role: "assistant", content: JSON.stringify(decision) }, finish_reason: "stop" },
        startedAt: t0,
      },
      {
        id: setId,
        runId,
        seq: 2,
        kind: "tool_call",
        name: "set_priority",
        input: { ticketId: "T-1", priority: decision.priority },
        output: { ok: true },
        sideEffect: true,
        fingerprint: toolFingerprint("set_priority", { ticketId: "T-1", priority: decision.priority }),
        startedAt: t0,
      },
    ],
  };
  const res = await api(ctx, "POST", "/v1/ingest", payload);
  expect(res.status).toBe(202);
  return { runId, llmId, lookupId, decision };
}

describe("POST /v1/corrections", () => {
  it("edit on a step freezes a case with input, recordings and expected", async () => {
    const { runId, llmId, decision } = await recordRun();
    const res = await api<CorrectionResult>(ctx, "POST", "/v1/corrections", {
      runId,
      stepId: llmId,
      kind: "edit",
      correctedOutput: { priority: "P1" },
      note: "Enterprise customer",
      actor: "rayfan@acme.com",
      source: "sdk",
    });
    expect(res.status).toBe(201);
    expect(res.body.correction).toMatchObject({
      runId,
      stepId: llmId,
      kind: "edit",
      source: "sdk",
      actor: "rayfan@acme.com",
    });
    const c = res.body.case!;
    expect(c).toMatchObject({
      runId,
      stepId: llmId,
      agent: "ticket-triage",
      kind: "edit",
      scorer: "json_match",
      expected: { priority: "P1" },
      originalOutput: decision,
      recordedModel: "fake-triage-v1",
      status: "active",
      truncated: false,
      tags: ["prod"],
      note: "Enterprise customer",
    });
    expect(c.frozenInput).toMatchObject({
      name: "chat.completions",
      model: "fake-triage-v1",
      provider: "openai",
      params: { temperature: 0 },
    });
    expect((c.frozenInput.messages as unknown[]).length).toBe(2);
    expect(c.frozenInput.response_format).toEqual({ type: "json_schema" });
    expect(Object.keys(c.toolRecordings)).toHaveLength(2);
    const lookup = c.toolRecordings[toolFingerprint("lookup_customer", { email: "a@b.c" })]!;
    expect(lookup).toEqual({
      name: "lookup_customer",
      args: { email: "a@b.c" },
      output: { plan: "enterprise" },
      sideEffect: false,
    });
    expect(c.title).toContain("edit: ticket-triage T-1");

    const run = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${runId}`);
    expect(run.body.correctionCount).toBe(1);
  });

  it("run-level approve uses the run output and the last llm step", async () => {
    const { runId, llmId, decision } = await recordRun({ externalId: "T-2" });
    const res = await api<CorrectionResult>(ctx, "POST", "/v1/corrections", {
      runId,
      kind: "approve",
      actor: "sam",
    });
    expect(res.status).toBe(201);
    expect(res.body.correction.stepId).toBeNull();
    expect(res.body.case).toMatchObject({
      stepId: llmId,
      kind: "approve",
      expected: decision,
      scorer: "json_match",
    });
  });

  it("reject and escalate derive expected from the kind", async () => {
    const r1 = await recordRun({ externalId: "T-3" });
    const rej = await api<CorrectionResult>(ctx, "POST", "/v1/corrections", {
      runId: r1.runId,
      kind: "reject",
      note: "wrong team",
    });
    expect(rej.body.case).toMatchObject({
      scorer: "not_equals",
      scorerConfig: { judge: true },
      expected: { not_equals: r1.decision, rubric: "wrong team" },
    });
    const r2 = await recordRun({ externalId: "T-4" });
    const esc = await api<CorrectionResult>(ctx, "POST", "/v1/corrections", {
      runId: r2.runId,
      kind: "escalate",
    });
    expect(esc.body.case).toMatchObject({
      scorer: "should_escalate",
      expected: { should_escalate: true, rubric: null },
    });
  });

  it("validates", async () => {
    const { runId, llmId, lookupId } = await recordRun({ externalId: "T-5" });
    expect((await api(ctx, "POST", "/v1/corrections", { runId, kind: "edit" })).status).toBe(400);
    expect(
      (await api(ctx, "POST", "/v1/corrections", { runId, stepId: lookupId, kind: "approve" })).status,
    ).toBe(400);
    expect((await api(ctx, "POST", "/v1/corrections", { runId: uuidv7(), kind: "approve" })).status).toBe(
      404,
    );
    expect((await api(ctx, "POST", "/v1/corrections", { runId, stepId: llmId, kind: "bogus" })).status).toBe(
      400,
    );
  });

  it("lists corrections by run", async () => {
    const { runId } = await recordRun({ externalId: "T-6" });
    await api(ctx, "POST", "/v1/corrections", { runId, kind: "approve" });
    await api(ctx, "POST", "/v1/corrections", { runId, kind: "reject" });
    const list = await api<unknown[]>(ctx, "GET", `/v1/corrections?runId=${runId}`);
    expect(list.body).toHaveLength(2);
  });

  it("truncates oversized frozen input and flags the case", () => {
    const big = "x".repeat(FROZEN_INPUT_MAX_BYTES / 4);
    const { input, truncated } = truncateFrozenInput({
      name: "chat",
      provider: null,
      model: null,
      params: null,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "user", content: big },
        { role: "user", content: "last" },
      ],
    });
    expect(truncated).toBe(true);
    const msgs = input.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.content).toBe("sys");
    expect(msgs[1]!.content).toMatch(/earlier messages dropped/);
    expect(msgs[msgs.length - 1]!.content).toBe("last");
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(FROZEN_INPUT_MAX_BYTES);
  });
});

describe("cases", () => {
  it("lists, filters, patches and saved sets work", async () => {
    const { runId } = await recordRun({ agent: "other-agent", externalId: "T-7", tags: ["eu"] });
    const created = await api<CorrectionResult>(ctx, "POST", "/v1/corrections", { runId, kind: "approve" });
    const caseId = created.body.case!.id;

    const byAgent = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?agent=other-agent");
    expect(byAgent.body.items.map((c) => c.id)).toEqual([caseId]);
    expect((byAgent.body.items[0] as unknown as Record<string, unknown>).frozenInput).toBeUndefined();
    const byTag = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?tag=eu");
    expect(byTag.body.items).toHaveLength(1);
    const byKind = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?kind=escalate");
    expect(byKind.body.items.every((c) => c.kind === "escalate")).toBe(true);

    const one = await api<Case>(ctx, "GET", `/v1/cases/${caseId}`);
    expect(one.body.frozenInput.name).toBe("chat.completions");

    const patched = await api<Case>(ctx, "PATCH", `/v1/cases/${caseId}`, {
      tags: ["eu", "golden"],
      scorer: "judge",
      status: "archived",
    });
    expect(patched.body).toMatchObject({ tags: ["eu", "golden"], scorer: "judge", status: "archived" });
    const activeOnly = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?agent=other-agent");
    expect(activeOnly.body.items).toHaveLength(0);
    const archived = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?agent=other-agent&status=archived");
    expect(archived.body.items).toHaveLength(1);

    const set = await api<CaseSet>(ctx, "POST", "/v1/case-sets", {
      name: "eu-golden",
      filter: { tag: "golden", status: "archived" },
    });
    expect(set.status).toBe(201);
    const viaSet = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?set=eu-golden");
    expect(viaSet.body.items.map((c) => c.id)).toEqual([caseId]);
    const sets = await api<CaseSet[]>(ctx, "GET", "/v1/case-sets");
    expect(sets.body.map((s) => s.name)).toContain("eu-golden");
    expect((await api(ctx, "DELETE", `/v1/case-sets/${set.body.id}`)).status).toBe(204);
    expect((await api(ctx, "GET", "/v1/cases?set=eu-golden")).status).toBe(404);
  });

  it("paginates", async () => {
    for (let i = 0; i < 3; i++) {
      const { runId } = await recordRun({ agent: "paged", externalId: `P-${i}` });
      await api(ctx, "POST", "/v1/corrections", { runId, kind: "approve" });
    }
    const p1 = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?agent=paged&limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await api<Page<CaseSummary>>(
      ctx,
      "GET",
      `/v1/cases?agent=paged&limit=2&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe("project settings + implicit approval", () => {
  it("reads and patches settings", async () => {
    const p = await api<Project>(ctx, "GET", "/v1/project");
    expect(p.body.settings.implicitApproveAfterDays).toBe(0);
    const patched = await api<Project>(ctx, "PATCH", "/v1/project", {
      settings: { implicitApproveAfterDays: 3, judgeModel: "openai/gpt-4.1-mini" },
    });
    expect(patched.body.settings).toMatchObject({ implicitApproveAfterDays: 3, retentionDays: 90 });
  });

  it("the sweeper approves old uncorrected runs once", async () => {
    const { JobsService } = await import("../jobs/jobs.service");
    const jobs = ctx.app.get(JobsService);
    const old = await recordRun({ agent: "sweep", externalId: "S-old", endedAt: "2026-10-01T00:00:00.000Z" });
    const fresh = await recordRun({ agent: "sweep", externalId: "S-new", endedAt: new Date().toISOString() });
    const n = await jobs.runImplicitApprovals();
    expect(n).toBeGreaterThanOrEqual(1);
    const oldRun = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${old.runId}`);
    expect(oldRun.body.correctionCount).toBe(1);
    const freshRun = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${fresh.runId}`);
    expect(freshRun.body.correctionCount).toBe(0);
    const cases = await api<Page<CaseSummary>>(ctx, "GET", "/v1/cases?agent=sweep");
    expect(cases.body.items).toHaveLength(1);
    expect(cases.body.items[0]!.kind).toBe("approve");
    expect(cases.body.items[0]!.actor).toBe("system");
    // idempotent
    const again = await jobs.runImplicitApprovals();
    const oldRun2 = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${old.runId}`);
    expect(oldRun2.body.correctionCount).toBe(1);
    expect(again).toBeLessThanOrEqual(n);
  });

  it("pg-boss starts with its queues and schedules (what boots in production)", async () => {
    const { JobsService } = await import("../jobs/jobs.service");
    const jobs = ctx.app.get(JobsService);
    await jobs.start();
    const schedules = await jobs.boss.getSchedules();
    expect(schedules.map((s) => s.name).sort()).toEqual(["cache-purge", "implicit-approve"]);
    expect(await jobs.boss.getQueue("replay")).not.toBeNull();
    await jobs.boss.stop({ graceful: false, timeout: 1000 });
  }, 30_000);
});
