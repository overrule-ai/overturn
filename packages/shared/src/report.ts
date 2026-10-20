import type { ReplayMatrix, ReplayReport, ReportRow } from "./schemas.js";

function fmt(v: unknown, max = 400): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function cell(v: unknown, max = 160): string {
  return fmt(v, max).replace(/\|/g, "\\|").replace(/`/g, "'");
}

/**
 * The replay receipt: what was re-run, what was simulated, what was blocked and what a green
 * result therefore does not prove. A CI check is only as useful as what "green" means.
 */
export function replayReceipt(report: ReplayReport): string[] {
  const rows = [
    ...report.regressions,
    ...report.stillWrong,
    ...report.fixed,
    ...report.passed,
    ...report.unreplayable,
    ...report.errors,
  ];
  const job = report.job;
  const refused = rows.reduce((n, r) => n + (r.refusedSideEffects?.length ?? 0), 0);
  const simulated = rows.reduce((n, r) => n + (r.simulatedToolCalls ?? 0), 0);
  const trajectory = job.mode === "trajectory";
  const items = [
    `**Replayed:** ${rows.length} case${rows.length === 1 ? "" : "s"} against \`${job.targetModel}\`${job.targetPromptVersion ? ` with prompt \`${job.targetPromptVersion}\`` : ""}, ${
      trajectory
        ? "whole trajectories through your agent code"
        : "the corrected model call only, with each step's frozen input"
    }.`,
    trajectory
      ? `**Simulated:** ${simulated} tool call${simulated === 1 ? "" : "s"} answered from the recordings; no tool executed.`
      : "**Simulated:** nothing executed; tool calls, retrieval and earlier steps were not exercised.",
    `**Blocked:** ${refused} side-effect tool call${refused === 1 ? "" : "s"} refused${refused > 0 ? " (the decision was scored, the effect never happened)" : ""}.`,
    "**Not tested:** live APIs, databases and retrieval as they are today; anything the recordings did not capture (timestamps, feature flags, hidden state).",
    "**Limits:** models are not deterministic, so a pass is one sample; scorers compare only what each case's scorer config says matters.",
  ];
  return ["### Replay receipt", "", ...items.map((i) => `- ${i}`), ""];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function section(title: string, rows: ReportRow[], emptyText: string): string[] {
  const out = [`### ${title} (${rows.length})`, ""];
  if (rows.length === 0) {
    out.push(`_${emptyText}_`, "");
    return out;
  }
  out.push("| Case | Kind | Baseline | Target | Human correction | Why |", "|---|---|---|---|---|---|");
  for (const r of rows) {
    const human =
      r.kind === "edit" ? r.expected : r.kind === "approve" ? "approved as-is" : (r.note ?? r.kind);
    const refused = r.refusedSideEffects?.length
      ? ` · refused side effects: ${r.refusedSideEffects.map((x) => x.toolName).join(", ")}`
      : "";
    const steps = r.stepCount !== undefined ? ` · ${r.stepCount} steps` : "";
    out.push(
      `| ${cell(r.title, 60)} | ${r.kind} | ${cell(r.baselineOutput)} | ${cell(r.error ?? r.targetOutput)} | ${cell(human)} | ${cell(r.reason, 120)}${steps}${refused} |`,
    );
  }
  out.push("");
  return out;
}

/** Markdown report: summary, then regressions, still-wrong, fixed. Used by the CLI, the API and the GitHub Action. */
export function renderMarkdownReport(
  report: ReplayReport,
  opts: { title?: string; link?: string } = {},
): string {
  const { job, summary } = report;
  const lines: string[] = [];
  lines.push(
    `## ${opts.title ?? "Overturn replay"}: \`${job.targetModel}\`${job.targetPromptVersion ? ` · prompt \`${job.targetPromptVersion}\`` : ""}`,
    "",
  );
  const baseline = summary.baseline
    ? summary.baseline.kind === "job"
      ? `job ${summary.baseline.jobId?.slice(-8)} (${summary.baseline.model})`
      : `recorded outputs (${summary.baseline.model ?? "original model"})`
    : "none";
  const verdictBits = Object.entries(summary.verdicts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  lines.push(
    `**${summary.completed}/${summary.cases} cases** · pass rate **${pct(summary.passRate)}** · ${verdictBits || "no verdicts"} · cost ${money(summary.costUsd)} · ${summary.durationMs != null ? `${(summary.durationMs / 1000).toFixed(1)}s` : "—"} · baseline: ${baseline}${summary.stoppedByCostCap ? " · **stopped by --max-cost**" : ""}`,
    "",
  );
  if (report.regressions.length > 0)
    lines.push(
      `> **${report.regressions.length} regression${report.regressions.length === 1 ? "" : "s"}**: cases a human approved that now fail.`,
      "",
    );
  lines.push(...section("Regressions", report.regressions, "No regressions."));
  lines.push(...section("Still wrong", report.stillWrong, "Nothing still wrong."));
  lines.push(...section("Fixed", report.fixed, "Nothing newly fixed."));
  if (report.unreplayable.length > 0) lines.push(...section("Unreplayable", report.unreplayable, ""));
  if (report.errors.length > 0) lines.push(...section("Errors", report.errors, ""));
  lines.push(
    `<details><summary>Passed (${report.passed.length})</summary>`,
    "",
    ...section("Passed", report.passed, "None.").slice(2),
    "</details>",
    "",
  );
  lines.push(...replayReceipt(report));
  if (opts.link) lines.push(`[Open the full report](${opts.link})`, "");
  lines.push(
    `<sub>Job \`${job.id}\` · mode ${job.mode} · [Overturn](https://github.com/overrule-ai/overturn)</sub>`,
  );
  return lines.join("\n");
}

const VERDICT_MARK: Record<string, string> = {
  pass: "✅",
  fixed: "✅ fixed",
  fail: "❌",
  regression: "🔴 regression",
  unreplayable: "⚠️ unreplayable",
  error: "⚠️ error",
};

/** Case × model matrix as markdown: one row per case, one column per model. */
export function renderMatrixMarkdown(m: ReplayMatrix): string {
  const cols = m.jobs.map((j) => j.targetModel);
  const lines = [
    `## Overturn replay matrix: ${m.cases.length} cases × ${m.jobs.length} models`,
    "",
    `| Model | Pass rate | Regressions | Fixed | Cost |`,
    `|---|---|---|---|---|`,
  ];
  for (const j of m.jobs) {
    const s = j.summary;
    lines.push(
      `| \`${j.targetModel}\` | ${s ? pct(s.passRate) : j.status} | ${s?.verdicts.regression ?? 0} | ${s?.verdicts.fixed ?? 0} | ${money(j.costUsd)} |`,
    );
  }
  lines.push(
    "",
    `| Case | ${cols.map((c) => `\`${c}\``).join(" | ")} |`,
    `|---|${cols.map(() => "---").join("|")}|`,
  );
  for (const c of m.cases) {
    const cells = m.jobs.map((j) => {
      const cell = c.cells[j.id];
      return cell?.verdict ? (VERDICT_MARK[cell.verdict] ?? cell.verdict) : "…";
    });
    lines.push(`| ${cell(c.title, 60)} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}
