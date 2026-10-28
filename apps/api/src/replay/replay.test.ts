import type {
  CorrectionResult,
  IngestPayload,
  ReplayEstimate,
  ReplayJob,
  ReplayMatrix,
  ReplayReport,
  ReplayResult,
  RunWithSteps,
} from "@overturn-ai/shared";
import { renderMarkdownReport, renderMatrixMarkdown, toolFingerprint } from "@overturn-ai/shared";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { echoModel, startFakeOpenAI } from "../test/fake-openai";
import { api, startTestApp, type TestContext } from "../test/harness";
import { buildMessages, fromAnthropicMessages, fromChatMessages } from "./model-call";
import { ReplayService, verdictFor } from "./replay.service";

let ctx: TestContext;
let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
let replay: ReplayService;

beforeAll(async () => {
  fake = await startFakeOpenAI();
  process.env.FAKE_OPENAI_URL = fake.url;
  ctx = await startTestApp();
  replay = ctx.app.get(ReplayService);
});
afterAll(async () => {
  await ctx.close();
  await fake.close();
});

async function recordRun(
  externalId: string,
  decision: Record<string, unknown>,
  opts: { tools?: boolean; agent?: string } = {},
) {
  const runId = uuidv7();
  const llmId = uuidv7();
  const t0 = new Date().toISOString();
  const output = opts.tools
    ? {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "set_priority", arguments: JSON.stringify(decision) },
            },
          ],
        },
        finish_reason: "tool_calls",
      }
    : { message: { role: "assistant", content: JSON.stringify(decision) }, finish_reason: "stop" };
  const payload: IngestPayload = {
    v: 1,
    runs: [
      {
        id: runId,
        agent: opts.agent ?? "triage",
        externalId,
        status: "completed",
        input: { id: externalId },
        output: opts.tools ? { tool_calls: [{ name: "set_priority", args: decision }] } : decision,
        startedAt: t0,
        endedAt: t0,
      },
    ],
    steps: [
      {
        id: uuidv7(),
        runId,
        seq: 0,
        kind: "tool_call",
        name: "lookup",
        input: { email: "a@b.c" },
        output: { plan: "pro" },
        fingerprint: toolFingerprint("lookup", { email: "a@b.c" }),
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
            { role: "system", content: "triage v1" },
            { role: "user", content: JSON.stringify({ id: externalId }) },
          ],
          ...(opts.tools
            ? {
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "set_priority",
                      parameters: {
                        type: "object",
                        properties: { ticketId: { type: "string" }, priority: { type: "string" } },
                        required: ["ticketId", "priority"],
                      },
                    },
                  },
                ],
              }
            : {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "d",
                    schema: {
                      type: "object",
                      properties: { priority: { type: "string" } },
                      required: ["priority"],
                      additionalProperties: false,
                    },
                  },
                },
              }),
        },
        params: { temperature: 0 },
        output,
        startedAt: t0,
      },
    ],
  };
  const res = await api(ctx, "POST", "/v1/ingest", payload);
  expect(res.status).toBe(202);
  return { runId, llmId };
}

async function correct(
  runId: string,
  kind: "approve" | "edit" | "reject" | "escalate",
  extra: Record<string, unknown> = {},
) {
  const res = await api<CorrectionResult>(ctx, "POST", "/v1/corrections", { runId, kind, ...extra });
  expect(res.status).toBe(201);
  return res.body.case!;
}

async function waitForJob(id: string): Promise<ReplayJob> {
  for (let i = 0; i < 100; i++) {
    const j = await api<ReplayJob>(ctx, "GET", `/v1/replays/${id}`);
    if (j.body.status !== "pending" && j.body.status !== "running") return j.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
}

describe("verdictFor", () => {
  it("follows the brief", () => {
    expect(verdictFor({ kind: "approve" }, false, true)).toBe("regression");
    expect(verdictFor({ kind: "approve" }, true, true)).toBe("pass");
    expect(verdictFor({ kind: "edit" }, true, false)).toBe("fixed");
    expect(verdictFor({ kind: "edit" }, false, false)).toBe("fail");
    expect(verdictFor({ kind: "reject" }, true, null)).toBe("pass");
  });
});

describe("message conversion", () => {
  it("converts OpenAI chat messages incl. tool calls and results", () => {
    const m = fromChatMessages([
      { role: "system", content: "s" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: '{"r":2}' },
    ]);
    expect(m.map((x) => x.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(m[2]!.content).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } }]);
  });
  it("converts Anthropic messages and swaps the system prompt", () => {
    const m = fromAnthropicMessages("sys", [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "u1", name: "t", input: { a: 1 } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "done" }] },
    ]);
    expect(m.map((x) => x.role)).toEqual(["system", "user", "assistant", "tool"]);
    const swapped = buildMessages(
      {
        name: "x",
        provider: "anthropic",
        model: null,
        params: null,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      },
      { systemPrompt: "new" },
    );
    expect(swapped[0]).toEqual({ role: "system", content: "new" });
  });
});

describe("replay jobs (step mode)", () => {
  it("estimates, runs, scores, assigns verdicts and reports", async () => {
    // approve case (expected = original P1); edit case (expected P0, original P2); reject case; tool-choice case
    const a = await recordRun("A-1", { priority: "P1" }, { agent: "replay-agent" });
    const approveCase = await correct(a.runId, "approve");
    const e = await recordRun("A-2", { priority: "P2" }, { agent: "replay-agent" });
    const editCase = await correct(e.runId, "edit", {
      correctedOutput: { priority: "P0" },
      note: "enterprise",
    });
    const r = await recordRun("A-3", { priority: "P3" }, { agent: "replay-agent" });
    const rejectCase = await correct(r.runId, "reject", { note: "should be higher" });

    const est = await api<ReplayEstimate>(ctx, "POST", "/v1/replays/estimate", {
      model: "openai/gpt-4.1-mini",
      filter: { agent: "replay-agent" },
    });
    expect(est.body.cases).toBe(3);
    expect(est.body.priced).toBe(true);
    expect(est.body.estimatedCostUsd).toBeGreaterThan(0);

    // target model answers P0 for everything: approve (P1) regresses, edit (P0) is fixed, reject (not P3) passes
    const created = await api<{ job: ReplayJob; estimate: ReplayEstimate }>(ctx, "POST", "/v1/replays", {
      model: echoModel({ priority: "P0" }),
      filter: { agent: "replay-agent" },
    });
    expect(created.status).toBe(201);
    expect(created.body.job.caseCount).toBe(3);
    const job = await waitForJob(created.body.job.id);
    expect(job.status).toBe("completed");
    expect(job.summary).toMatchObject({
      cases: 3,
      completed: 3,
      passed: 2,
      failed: 1,
      verdicts: { regression: 1, fixed: 2 },
    });
    expect(job.summary!.baseline).toEqual({ kind: "recorded", jobId: null, model: "fake-triage-v1" });

    const results = await api<ReplayResult[]>(ctx, "GET", `/v1/replays/${job.id}/results`);
    const byCase = new Map(results.body.map((x) => [x.caseId, x]));
    expect(byCase.get(approveCase.id)).toMatchObject({
      verdict: "regression",
      passed: false,
      output: { priority: "P0" },
    });
    expect(byCase.get(editCase.id)).toMatchObject({ verdict: "fixed", passed: true });
    expect(byCase.get(rejectCase.id)).toMatchObject({ verdict: "fixed", passed: true });
    expect(byCase.get(approveCase.id)!.diff).toMatchObject({
      expected: { priority: "P1" },
      baseline: { priority: "P1" },
      target: { priority: "P0" },
    });

    const report = await api<ReplayReport>(ctx, "GET", `/v1/replays/${job.id}/report`);
    expect(report.body.regressions.map((x) => x.caseId)).toEqual([approveCase.id]);
    expect(report.body.fixed.map((x) => x.caseId).sort()).toEqual([editCase.id, rejectCase.id].sort());
    expect(report.body.regressions[0]).toMatchObject({
      baselineOutput: { priority: "P1" },
      targetOutput: { priority: "P0" },
      expected: { priority: "P1" },
      kind: "approve",
    });
    const md = renderMarkdownReport(report.body);
    expect(md).toContain("### Regressions (1)");
    expect(md).toContain("### Fixed (2)");
    expect(md).toContain("pass rate **66.7%**");
    const mdRes = await fetch(`${ctx.baseUrl}/v1/replays/${job.id}/report.md`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(mdRes.headers.get("content-type")).toContain("text/markdown");
    expect(await mdRes.text()).toContain("Regressions");

    // the case remembers its last verdict
    const c = await api<{ lastVerdict: string }>(ctx, "GET", `/v1/cases/${approveCase.id}`);
    expect(c.body.lastVerdict).toBe("regression");

    // second job with the same model hits the 24h cache: no new model calls
    const before = fake.calls.length;
    const again = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: echoModel({ priority: "P0" }),
      filter: { agent: "replay-agent" },
    });
    const job2 = await waitForJob(again.body.job.id);
    expect(job2.status).toBe("completed");
    expect(fake.calls.length).toBe(before);
    expect(job2.costUsd).toBe(0);
  });

  it("uses a prior job for the baseline when one exists for the recorded model", async () => {
    const a = await recordRun("B-1", { priority: "P1" }, { agent: "baseline-agent" });
    await correct(a.runId, "approve");
    // a completed job for the recorded model (fake-triage-v1) becomes the baseline
    const base = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: "fake/fake-triage-v1",
      filter: { agent: "baseline-agent" },
    });
    const baseJob = await waitForJob(base.body.job.id);
    expect(baseJob.status).toBe("completed");
    const next = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: echoModel({ priority: "P1" }),
      filter: { agent: "baseline-agent" },
    });
    const job = await waitForJob(next.body.job.id);
    expect(job.summary!.baseline).toMatchObject({ kind: "job", jobId: baseJob.id });
  });

  it("scores tool decisions with tool_choice", async () => {
    const a = await recordRun(
      "C-1",
      { ticketId: "T-1", priority: "P1" },
      { tools: true, agent: "tool-agent" },
    );
    const c = await correct(a.runId, "approve");
    expect(c.scorer).toBe("tool_choice");
    const created = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: "fake/tool-set_priority",
      filter: { agent: "tool-agent" },
    });
    const job = await waitForJob(created.body.job.id);
    expect(job.summary!.verdicts).toEqual({ pass: 1 });
    const results = await api<ReplayResult[]>(ctx, "GET", `/v1/replays/${job.id}/results`);
    expect(results.body[0]!.output).toEqual({
      tool_calls: [{ name: "set_priority", args: { ticketId: "T-1", priority: "P1" } }],
    });
  });

  it("retries rate limits, swaps prompt versions, and stops at the cost cap", async () => {
    const a = await recordRun("D-1", { priority: "P1" }, { agent: "retry-agent" });
    await correct(a.runId, "approve");
    const created = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: "fake/fail-429",
      filter: { agent: "retry-agent" },
    });
    const job = await waitForJob(created.body.job.id);
    expect(job.status).toBe("completed");
    expect(job.summary!.completed).toBe(1);

    // prompt version targeting: the system message is replaced
    const reg = await api(ctx, "POST", "/v1/prompts", {
      name: "triage",
      version: "v2",
      template: "triage v2 with enterprise rule",
    });
    expect(reg.status).toBe(201);
    const missing = await api(ctx, "POST", "/v1/replays", {
      model: echoModel({ priority: "P1" }),
      promptVersion: "triage@v9",
      filter: { agent: "retry-agent" },
    });
    expect(missing.status).toBe(404);
    const callsBefore = fake.calls.length;
    const withPrompt = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: echoModel({ priority: "P1" }),
      promptVersion: "triage@v2",
      filter: { agent: "retry-agent" },
    });
    const pj = await waitForJob(withPrompt.body.job.id);
    expect(pj.status).toBe("completed");
    const call = fake.calls[callsBefore] as { messages: Array<{ role: string; content: string }> };
    expect(call.messages[0]).toEqual({ role: "system", content: "triage v2 with enterprise rule" });

    // cost cap: a priced model with a tiny cap stops cleanly and keeps partial results
    for (let i = 0; i < 40; i++) {
      const r = await recordRun(`E-${i}`, { priority: "P1" }, { agent: "cap-agent" });
      await correct(r.runId, "approve");
    }
    const capped = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: echoModel({ priority: "P1" }, true),
      filter: { agent: "cap-agent" },
      maxCostUsd: 0.00005,
      start: false,
    });
    expect(capped.status).toBe(201);
    const cj = await replay.runJob(capped.body.job.id);
    expect(cj.status).toBe("completed");
    expect(cj.summary!.stoppedByCostCap).toBe(true);
    expect(cj.summary!.completed).toBeLessThan(40);
    expect(cj.summary!.completed).toBeGreaterThan(0);
    expect(cj.costUsd).toBeGreaterThan(0);
  });

  it("rejects unconfigured providers and empty filters", async () => {
    const none = await api<{ message: string }>(ctx, "POST", "/v1/replays", {
      model: "openai/gpt-4.1-mini",
      filter: { agent: "nope" },
    });
    expect(none.status).toBe(400);
    const bad = await api<{ message: string }>(ctx, "POST", "/v1/replays", {
      model: "unknownprovider/x",
      filter: {},
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/not configured/);
  });

  it("accepts trajectory results posted by the runner", async () => {
    const a = await recordRun("F-1", { priority: "P1" }, { agent: "traj-agent" });
    const c1 = await correct(a.runId, "approve");
    const b = await recordRun("F-2", { priority: "P2" }, { agent: "traj-agent" });
    const c2 = await correct(b.runId, "edit", { correctedOutput: { priority: "P1" } });
    const created = await api<{ job: ReplayJob; caseIds: string[] }>(ctx, "POST", "/v1/replays", {
      model: "openai/gpt-4.1-mini",
      mode: "trajectory",
      filter: { agent: "traj-agent" },
    });
    expect(created.status).toBe(201);
    expect(created.body.job.status).toBe("pending");
    expect(created.body.caseIds.sort()).toEqual([c1.id, c2.id].sort());
    const posted = await api<ReplayJob>(ctx, "POST", `/v1/replays/${created.body.job.id}/results`, {
      results: [
        { caseId: c1.id, output: { priority: "P1" }, latencyMs: 120, costUsd: 0.001 },
        { caseId: c2.id, unreplayable: { toolName: "send_email", args: { to: "x" }, reason: "refused" } },
      ],
      finish: true,
    });
    expect(posted.status).toBe(200);
    expect(posted.body.status).toBe("completed");
    expect(posted.body.summary!.verdicts).toEqual({ pass: 1, unreplayable: 1 });
    const report = await api<ReplayReport>(ctx, "GET", `/v1/replays/${created.body.job.id}/report`);
    expect(report.body.unreplayable[0]!.reason).toMatch(/side-effect tool refused: send_email/);
    // trajectory details reach the report rows and the markdown
    const posted2 = await api<{ job: ReplayJob; caseIds: string[] }>(ctx, "POST", "/v1/replays", {
      model: "openai/gpt-4.1-mini",
      mode: "trajectory",
      filter: { agent: "traj-agent" },
    });
    await api(ctx, "POST", `/v1/replays/${posted2.body.job.id}/results`, {
      results: [
        {
          caseId: c1.id,
          output: { priority: "P1" },
          steps: [
            { kind: "tool_call", name: "lookup" },
            { kind: "llm_call", name: "chat", model: "m" },
          ],
          refusedSideEffects: [{ toolName: "set_priority", args: { p: "P1" } }],
        },
        { caseId: c2.id, output: { priority: "P1" } },
      ],
      finish: true,
    });
    const r2 = await api<ReplayReport>(ctx, "GET", `/v1/replays/${posted2.body.job.id}/report`);
    const row = [...r2.body.passed, ...r2.body.fixed].find((x) => x.caseId === c1.id)!;
    expect(row.stepCount).toBe(2);
    expect(row.refusedSideEffects).toEqual([{ toolName: "set_priority", args: { p: "P1" } }]);
    const md = await fetch(`${ctx.baseUrl}/v1/replays/${posted2.body.job.id}/report.md`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    }).then((r) => r.text());
    expect(md).toContain("refused side effects: set_priority");
  });

  it("new path: a tool call with no recording needs a human, and accepting it answers future replays", async () => {
    const a = await recordRun("NP-1", { priority: "P1" }, { agent: "np-agent" });
    const c = await correct(a.runId, "approve");
    const created = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: "openai/gpt-4.1-mini",
      mode: "trajectory",
      filter: { agent: "np-agent" },
    });
    const jobId = created.body.job.id;
    // the agent looked the customer up by a different key: same tool, new fingerprint
    const posted = await api<ReplayJob>(ctx, "POST", `/v1/replays/${jobId}/results`, {
      results: [
        { caseId: c.id, unreplayable: { toolName: "lookup", args: { email: "A@b.c" }, reason: "unseen" } },
      ],
      finish: true,
    });
    expect(posted.body.summary!.verdicts).toEqual({ new_path: 1 });
    const report = await api<ReplayReport>(ctx, "GET", `/v1/replays/${jobId}/report`);
    expect(report.body.newPaths).toHaveLength(1);
    const row = report.body.newPaths[0]!;
    expect(row.verdict).toBe("new_path");
    expect(row.newPath!.toolName).toBe("lookup");
    expect(row.newPath!.candidates).toEqual([
      { fingerprint: toolFingerprint("lookup", { email: "a@b.c" }), args: { email: "a@b.c" } },
    ]);
    // the gate is red until a human accepts the path
    expect(report.body.gate).toEqual({
      pass: false,
      reasons: ["1 new path not yet accepted"],
      newPathsBlock: true,
    });
    const md = await fetch(`${ctx.baseUrl}/v1/replays/${jobId}/report.md`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    }).then((r) => r.text());
    expect(md).toContain("### New paths (1)");

    // accept as equivalent: one click records the fingerprint and lets the result stand
    const accepted = await api<{
      toolRecordings: Record<string, { equivalentOf?: string; note?: string | null }>;
    }>(ctx, "POST", `/v1/cases/${c.id}/equivalents`, {
      toolName: "lookup",
      args: { email: "A@b.c" },
      equivalentOf: row.newPath!.candidates[0]!.fingerprint,
      note: "same lookup, upper-cased email",
      actor: "sam@example.com",
      jobId,
    });
    expect(accepted.status).toBe(201);
    const fp = toolFingerprint("lookup", { email: "A@b.c" });
    expect(accepted.body.toolRecordings[fp]).toMatchObject({
      equivalentOf: row.newPath!.candidates[0]!.fingerprint,
      note: "same lookup, upper-cased email",
    });
    const after = await api<ReplayReport>(ctx, "GET", `/v1/replays/${jobId}/report`);
    expect(after.body.newPaths).toHaveLength(0);
    expect(after.body.passed.map((r) => r.caseId)).toEqual([c.id]);
    expect(after.body.passed[0]!.reason).toMatch(/accepted as equivalent/);
    expect(after.body.gate!.pass).toBe(true);
    // a mismatched recording is refused
    const bad = await api(ctx, "POST", `/v1/cases/${c.id}/equivalents`, {
      toolName: "send_email",
      args: {},
      equivalentOf: row.newPath!.candidates[0]!.fingerprint,
    });
    expect(bad.status).toBe(400);
  });

  it("outcome contract: broken rules fail the case whatever the scorer says", async () => {
    const a = await recordRun("CT-1", { priority: "P1" }, { agent: "ct-agent" });
    const c = await correct(a.runId, "approve", {
      contract: [
        { type: "tool_called", tool: "refund", count: "never" },
        { type: "tool_called", tool: "lookup", count: "once" },
        { type: "answer", contains: "P1" },
      ],
    });
    expect(c.contract).toHaveLength(3);
    const created = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: "openai/gpt-4.1-mini",
      mode: "trajectory",
      filter: { agent: "ct-agent" },
    });
    const jobId = created.body.job.id;
    // right answer, but it called refund and skipped the lookup → contract violation → regression
    const posted = await api<ReplayJob>(ctx, "POST", `/v1/replays/${jobId}/results`, {
      results: [
        {
          caseId: c.id,
          output: { priority: "P1" },
          steps: [
            { kind: "tool_call", name: "refund" },
            { kind: "llm_call", name: "chat" },
          ],
        },
      ],
      finish: true,
    });
    expect(posted.body.summary!.verdicts).toEqual({ regression: 1 });
    const report = await api<ReplayReport>(ctx, "GET", `/v1/replays/${jobId}/report`);
    const row = report.body.regressions[0]!;
    expect(row.contractViolations).toEqual([
      "never call refund — called 1×",
      "call lookup exactly once — called 0×",
    ]);
    expect(row.reason).toMatch(/^contract: never call refund/);
    expect(report.body.gate!.reasons).toEqual(["1 regression"]);
    // the contract is editable on the case
    const patched = await api<{ contract: unknown[] }>(ctx, "PATCH", `/v1/cases/${c.id}`, {
      contract: [{ type: "answer", contains: "P1" }],
    });
    expect(patched.body.contract).toHaveLength(1);
    const bad = await api(ctx, "PATCH", `/v1/cases/${c.id}`, { contract: [{ type: "nope" }] });
    expect(bad.status).toBe(400);
  });

  it("suppress: a case leaves the default suite, stays countable and comes back", async () => {
    const a = await recordRun("SP-1", { priority: "P1" }, { agent: "sp-agent" });
    const c = await correct(a.runId, "approve");
    const before = await api<{ active: number; suppressed: number }>(ctx, "GET", "/v1/cases/counts");
    await api(ctx, "PATCH", `/v1/cases/${c.id}`, { status: "suppressed" });
    const counts = await api<{ active: number; suppressed: number }>(ctx, "GET", "/v1/cases/counts");
    expect(counts.body.suppressed).toBe(before.body.suppressed + 1);
    expect(counts.body.active).toBe(before.body.active - 1);
    const est = await api<ReplayEstimate>(ctx, "POST", "/v1/replays/estimate", {
      model: "openai/gpt-4.1-mini",
      filter: { agent: "sp-agent" },
    });
    expect(est.body.cases).toBe(0);
    const listed = await api<{ items: { id: string }[] }>(
      ctx,
      "GET",
      "/v1/cases?status=suppressed&agent=sp-agent",
    );
    expect(listed.body.items.map((x) => x.id)).toEqual([c.id]);
    await api(ctx, "PATCH", `/v1/cases/${c.id}`, { status: "active" });
    const est2 = await api<ReplayEstimate>(ctx, "POST", "/v1/replays/estimate", {
      model: "openai/gpt-4.1-mini",
      filter: { agent: "sp-agent" },
    });
    expect(est2.body.cases).toBe(1);
  });

  it("exports corrections as SFT and DPO fine-tuning datasets", async () => {
    const a = await recordRun("EX-1", { priority: "P1" }, { agent: "export-agent" });
    await correct(a.runId, "approve");
    const b = await recordRun("EX-2", { priority: "P3" }, { agent: "export-agent" });
    await correct(b.runId, "edit", { correctedOutput: { priority: "P0" }, note: "outage" });
    const c = await recordRun("EX-3", { priority: "P2" }, { agent: "export-agent" });
    await correct(c.runId, "reject", { note: "wrong team" });
    const d = await recordRun(
      "EX-4",
      { ticketId: "T", priority: "P1" },
      { agent: "export-agent", tools: true },
    );
    await correct(d.runId, "approve");

    const stats = await api<{ rows: number; byKind: Record<string, number>; skipped: number }>(
      ctx,
      "GET",
      "/v1/export/stats?format=sft&agent=export-agent",
    );
    expect(stats.body.rows).toBe(3);
    expect(stats.body.byKind).toEqual({ approve: 2, edit: 1 });
    expect(stats.body.skipped).toBe(1);

    const res = await fetch(`${ctx.baseUrl}/v1/export?format=sft&agent=export-agent`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.headers.get("x-overturn-rows")).toBe("3");
    const rows = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.messages[0].role).toBe("system");
      expect(r.messages[r.messages.length - 1].role).toBe("assistant");
    }
    const edited = rows.find((r) => r.meta.kind === "edit")!;
    expect(edited.messages.at(-1)).toEqual({
      role: "assistant",
      content: JSON.stringify({ priority: "P0" }),
    });
    const tooly = rows.find((r) => r.tools)!;
    const last = tooly.messages.at(-1);
    expect(last.tool_calls[0].function.name).toBe("set_priority");
    expect(JSON.parse(last.tool_calls[0].function.arguments)).toEqual({ ticketId: "T", priority: "P1" });

    const dpo = await fetch(`${ctx.baseUrl}/v1/export?format=dpo&agent=export-agent`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(dpo.headers.get("x-overturn-rows")).toBe("1");
    const [pair] = (await dpo.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(pair.chosen).toEqual({ role: "assistant", content: JSON.stringify({ priority: "P0" }) });
    expect(pair.rejected).toEqual({ role: "assistant", content: JSON.stringify({ priority: "P3" }) });
    expect(pair.messages.at(-1).role).toBe("user");
    // nothing to train on without edits
    const none = await api<{ rows: number }>(ctx, "GET", "/v1/export/stats?format=dpo&agent=np-agent");
    expect(none.body.rows).toBe(0);
  });

  it("replays the same cases against several models as a group and builds the matrix", async () => {
    const good = echoModel({ priority: "P1" });
    const bad = echoModel({ priority: "P3" });
    const created = await api<{ job: ReplayJob; jobs: ReplayJob[] }>(ctx, "POST", "/v1/replays", {
      model: good,
      models: [bad],
      filter: { agent: "replay-agent" },
    });
    expect(created.status).toBe(201);
    expect(created.body.jobs).toHaveLength(2);
    const groupId = created.body.job.groupId!;
    expect(groupId).toBeTruthy();
    expect(created.body.jobs.every((j) => j.groupId === groupId)).toBe(true);
    for (const j of created.body.jobs) expect((await waitForJob(j.id)).status).toBe("completed");
    const m = await api<ReplayMatrix>(ctx, "GET", `/v1/replays/groups/${groupId}`);
    expect(m.status).toBe(200);
    expect(m.body.jobs.map((j) => j.targetModel)).toEqual([good, bad]);
    expect(m.body.cases).toHaveLength(3);
    const approveRow = m.body.cases.find((c) => c.kind === "approve")!;
    expect(approveRow.cells[created.body.jobs[0]!.id]!.verdict).toBe("pass");
    expect(approveRow.cells[created.body.jobs[1]!.id]!.verdict).toBe("regression");
    const md = renderMatrixMarkdown(m.body);
    expect(md).toContain("3 cases × 2 models");
    expect(md).toContain("🔴 regression");
    // a single-model replay has no group
    const single = await api<{ job: ReplayJob; jobs: ReplayJob[] }>(ctx, "POST", "/v1/replays", {
      model: good,
      filter: { agent: "replay-agent" },
      start: false,
    });
    expect(single.body.jobs).toHaveLength(1);
    expect(single.body.job.groupId).toBeNull();
  });

  it("run detail still works after replays", async () => {
    const list = await api<{ items: unknown[] }>(ctx, "GET", "/v1/replays");
    expect(list.body).toBeInstanceOf(Array);
    const anyRun = await api<{ items: Array<{ id: string }> }>(ctx, "GET", "/v1/runs?limit=1");
    const run = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${anyRun.body.items[0]!.id}`);
    expect(run.status).toBe(200);
  });
});
