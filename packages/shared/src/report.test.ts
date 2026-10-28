import { describe, expect, it } from "vitest";
import { narrative, renderMarkdownReport } from "./report.js";
import type { ReplayReport, ReportRow } from "./schemas.js";

const ID = "01a00000-0000-7000-8000-000000000000";

function row(over: Partial<ReportRow>): ReportRow {
  return {
    caseId: ID,
    title: "edit: ticket-triage T-1",
    kind: "edit",
    agent: "ticket-triage",
    runId: ID,
    scorer: "json_match",
    verdict: "pass",
    passed: true,
    score: 1,
    reason: null,
    baselineOutput: null,
    targetOutput: null,
    expected: null,
    note: null,
    actor: null,
    error: null,
    costUsd: null,
    latencyMs: 120,
    ...over,
  };
}

function report(over: Partial<ReplayReport>): ReplayReport {
  return {
    job: {
      id: ID,
      projectId: ID,
      targetModel: "together/deepseek-ai/DeepSeek-V4.1-Flash",
      targetPromptVersion: null,
      options: { examples: 0 },
      groupId: null,
      startedBy: null,
      mode: "step",
      caseFilter: {},
      status: "completed",
      summary: null,
      estimatedCostUsd: null,
      maxCostUsd: null,
      costUsd: 0.0015,
      caseCount: 4,
      completedCount: 4,
      error: null,
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-10-27T00:00:00.000Z",
    },
    summary: {
      cases: 4,
      completed: 4,
      passed: 3,
      failed: 1,
      passRate: 0.75,
      verdicts: {
        regression: 1,
        fixed: 2,
        pass: 1,
        fail: 0,
        error: 0,
        unchanged: 0,
        unreplayable: 0,
        new_path: 0,
      },
      costUsd: 0.0015,
      durationMs: 1000,
      baseline: { kind: "recorded", jobId: null, model: "fake-triage-v1" },
      stoppedByCostCap: false,
      latencyP50Ms: 163,
      costPerCallUsd: 0.0000166,
    },
    regressions: [],
    newPaths: [],
    stillWrong: [],
    fixed: [],
    passed: [],
    unreplayable: [],
    errors: [],
    gate: { pass: true, reasons: [], newPathsBlock: true },
    ...over,
  };
}

describe("narrative", () => {
  it("names the fields regressions broke, counts fixes, and reports cost and speed", () => {
    const r = report({
      regressions: [
        row({
          kind: "approve",
          verdict: "regression",
          passed: false,
          expected: {
            priority: "P0",
            team: "billing",
            reply: "Hi there. We have escalated this to the billing team and will follow up today.",
          },
          targetOutput: {
            priority: "P2",
            team: "billing",
            reply: "Hello. Thanks for reaching out, we will look into it.",
          },
        }),
      ],
      fixed: [row({ verdict: "fixed" }), row({ verdict: "fixed" })],
      stillWrong: [row({ verdict: "fail", passed: false })],
      gate: { pass: false, reasons: ["1 regression"], newPathsBlock: true },
    });
    const lines = narrative(r);
    expect(lines[0]).toBe(
      "**1 regression** against the recorded runs (fake-triage-v1): a case a human approved now fails on `priority`.",
    );
    expect(lines).toContainEqual(
      "**2 cases fixed**: answers a human had to correct now come out right unprompted.",
    );
    expect(lines).toContainEqual("1 case still wrong, as before — not a regression, but not fixed either.");
    expect(lines.at(-1)).toBe("Cost and speed: $0.0000 per call, p50 163 ms ($0.0015 for the run).");
    const md = renderMarkdownReport(r);
    expect(md).toContain("**What changed**");
    expect(md).toContain("· 120 ms |");
  });

  it("says plainly when nothing regressed and lists new paths by tool", () => {
    const r = report({
      newPaths: [
        row({
          verdict: "new_path",
          passed: null,
          newPath: { toolName: "refund", args: { amount: 10 }, fingerprint: "x", candidates: [] },
        }),
      ],
    });
    const lines = narrative(r);
    expect(lines[0]).toBe(
      "No regressions against the recorded runs (fake-triage-v1): every case a human approved still passes on `together/deepseek-ai/DeepSeek-V4.1-Flash`.",
    );
    expect(lines[1]).toContain("**1 new path**: the agent called `refund`");
  });
});
