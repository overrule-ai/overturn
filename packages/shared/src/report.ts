import type { ReplayReport, ReportRow } from "./schemas.js";

function fmt(v: unknown, max = 400): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function cell(v: unknown, max = 160): string {
  return fmt(v, max).replace(/\|/g, "\\|").replace(/`/g, "'");
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
    out.push(
      `| ${cell(r.title, 60)} | ${r.kind} | ${cell(r.baselineOutput)} | ${cell(r.error ?? r.targetOutput)} | ${cell(human)} | ${cell(r.reason, 120)} |`,
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
  if (opts.link) lines.push(`[Open the full report](${opts.link})`, "");
  lines.push(
    `<sub>Job \`${job.id}\` · mode ${job.mode} · [Overturn](https://github.com/overrule-ai/overturn)</sub>`,
  );
  return lines.join("\n");
}
