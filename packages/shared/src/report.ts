import { decisionFields } from "./cases.js";
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
    ...(report.newPaths ?? []),
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

function get(v: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      v,
    );
}

/** The decision fields of a row's expected answer that the target got wrong. */
function wrongFields(r: ReportRow): string[] {
  const { fields } = decisionFields(r.expected);
  return fields.filter(
    (f) => JSON.stringify(get(r.targetOutput, f) ?? null) !== JSON.stringify(get(r.expected, f) ?? null),
  );
}

function count<T>(items: T[], key: (t: T) => string | null): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What changed, in sentences: the paragraph a reviewer reads before the tables. Derived from the
 * rows only, so the CLI, the PR comment and the web all say the same thing.
 */
export function narrative(report: ReplayReport): string[] {
  const { summary, job } = report;
  const out: string[] = [];
  const baseline =
    summary.baseline?.kind === "job"
      ? `the previous replay on ${summary.baseline.model}`
      : `the recorded runs${summary.baseline?.model ? ` (${summary.baseline.model})` : ""}`;
  const reg = report.regressions;
  if (reg.length === 0 && summary.completed > 0)
    out.push(
      `No regressions against ${baseline}: every case a human approved still passes on \`${job.targetModel}\`.`,
    );
  if (reg.length > 0) {
    const fields = count(reg, (r) => wrongFields(r).join(", ") || null);
    const agents = count(reg, (r) => r.agent);
    const where =
      fields.length > 0
        ? ` on ${fields.map(([f, n]) => `\`${f}\`${fields.length > 1 ? ` (${n})` : ""}`).join(", ")}`
        : "";
    const who = agents.length > 1 ? ` across ${agents.map(([a, n]) => `${a} (${n})`).join(", ")}` : "";
    out.push(
      `**${plural(reg.length, "regression")}** against ${baseline}: ${reg.length === 1 ? "a case" : "cases"} a human approved now ${reg.length === 1 ? "fails" : "fail"}${where}${who}.`,
    );
    const contracts = reg.filter((r) => r.contractViolations?.length);
    if (contracts.length > 0)
      out.push(
        `${plural(contracts.length, "of them breaks a contract rule", "of them break contract rules")}: ${[...new Set(contracts.flatMap((r) => r.contractViolations ?? []))].slice(0, 3).join("; ")}.`,
      );
  }
  const np = report.newPaths ?? [];
  if (np.length > 0) {
    const tools = count(np, (r) => r.newPath?.toolName ?? null);
    out.push(
      `**${plural(np.length, "new path")}**: the agent called ${tools.map(([t, n]) => `\`${t}\`${n > 1 ? ` (${n}×)` : ""}`).join(", ")} with arguments no recording answers. Accept or correct them; the gate stays red until then.`,
    );
  }
  if (report.fixed.length > 0)
    out.push(
      `**${plural(report.fixed.length, "case")} fixed**: ${report.fixed.length === 1 ? "an answer" : "answers"} a human had to correct now ${report.fixed.length === 1 ? "comes" : "come"} out right unprompted.`,
    );
  if (report.stillWrong.length > 0)
    out.push(
      `${plural(report.stillWrong.length, "case")} still wrong, as before — not a regression, but not fixed either.`,
    );
  const unrep = report.unreplayable.length + report.errors.length;
  if (unrep > 0)
    out.push(
      `${plural(unrep, "case")} could not be judged (${report.unreplayable.length} unreplayable, ${report.errors.length} errored) and ${unrep === 1 ? "is" : "are"} not counted as passing.`,
    );
  const perf: string[] = [];
  if (summary.costPerCallUsd != null) perf.push(`${money(summary.costPerCallUsd)} per call`);
  if (summary.latencyP50Ms != null) perf.push(`p50 ${Math.round(summary.latencyP50Ms)} ms`);
  if (perf.length > 0)
    out.push(`Cost and speed: ${perf.join(", ")} (${money(summary.costUsd)} for the run).`);
  return out;
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
    const contract = r.contractViolations?.length ? ` · contract: ${r.contractViolations.join("; ")}` : "";
    const latency = r.latencyMs != null ? ` · ${Math.round(r.latencyMs)} ms` : "";
    out.push(
      `| ${cell(r.title, 60)} | ${r.kind} | ${cell(r.baselineOutput)} | ${cell(r.error ?? r.targetOutput)} | ${cell(human)} | ${cell(r.reason, 120)}${contract}${steps}${refused}${latency} |`,
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
  const story = narrative(report);
  if (story.length > 0) lines.push("**What changed**", "", ...story.map((l) => `- ${l}`), "");
  lines.push(...section("Regressions", report.regressions, "No regressions."));
  const newPaths = report.newPaths ?? [];
  if (newPaths.length > 0) {
    lines.push(
      `### New paths (${newPaths.length})`,
      "",
      "_The agent called a tool with no recording. Accept the call as equivalent to a recorded one on the case page, or correct the run; until then the gate stays red._",
      "",
      "| Case | New call | Closest recorded call |",
      "|---|---|---|",
    );
    for (const r of newPaths) {
      const np = r.newPath;
      lines.push(
        `| ${cell(r.title, 60)} | \`${np?.toolName ?? "?"}\` ${cell(np?.args)} | ${np?.candidates[0] ? cell(np.candidates[0].args) : "— (tool never recorded)"} |`,
      );
    }
    lines.push("");
  }
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
  new_path: "🟣 new path",
  error: "⚠️ error",
};

/** Case × model matrix as markdown: one row per case, one column per model. */
export function renderMatrixMarkdown(m: ReplayMatrix): string {
  const cols = m.jobs.map((j) => j.targetModel);
  const lines = [
    `## Overturn replay matrix: ${m.cases.length} cases × ${m.jobs.length} models`,
    "",
    `| Model | Pass rate | Regressions | Fixed | Cost | Cost / call | p50 latency | vs incumbent |`,
    `|---|---|---|---|---|---|---|---|`,
  ];
  const card = new Map((m.scorecard ?? []).map((r) => [r.jobId, r]));
  for (const j of m.jobs) {
    const s = j.summary;
    const r = card.get(j.id);
    const vs = r?.incumbent
      ? "incumbent"
      : r?.vsIncumbent
        ? [
            r.vsIncumbent.passRatePoints != null
              ? `${r.vsIncumbent.passRatePoints >= 0 ? "+" : ""}${r.vsIncumbent.passRatePoints} pts`
              : null,
            r.vsIncumbent.costRatio != null ? `${r.vsIncumbent.costRatio}× cost` : null,
          ]
            .filter(Boolean)
            .join(", ")
        : "—";
    lines.push(
      `| \`${j.targetModel}\` | ${s ? pct(s.passRate) : j.status} | ${s?.verdicts.regression ?? 0} | ${s?.verdicts.fixed ?? 0} | ${money(j.costUsd)} | ${s?.costPerCallUsd != null ? `$${s.costPerCallUsd.toFixed(4)}` : "—"} | ${s?.latencyP50Ms != null ? `${Math.round(s.latencyP50Ms)} ms` : "—"} | ${vs} |`,
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
