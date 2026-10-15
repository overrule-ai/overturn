import type {
  CorrectionResult,
  IngestPayload,
  ReplayEstimate,
  ReplayJob,
  ReplayReport,
  ReplayResult,
  RunWithSteps,
} from "@overturn-ai/shared";
import { renderMarkdownReport, toolFingerprint } from "@overturn-ai/shared";
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
  });

  it("run detail still works after replays", async () => {
    const list = await api<{ items: unknown[] }>(ctx, "GET", "/v1/replays");
    expect(list.body).toBeInstanceOf(Array);
    const anyRun = await api<{ items: Array<{ id: string }> }>(ctx, "GET", "/v1/runs?limit=1");
    const run = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${anyRun.body.items[0]!.id}`);
    expect(run.status).toBe(200);
  });
});
