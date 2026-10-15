import { writeFileSync } from "node:fs";
import { type ReplayJob, type ReplayReport, renderMarkdownReport } from "@overturn/shared";
import type { Command } from "commander";
import pc from "picocolors";
import { ago, apiFor, type CliOptions, fail, parseSince, printJson, shortId, table } from "../context.js";

export interface ReplayOptions {
  model: string;
  mode: "step" | "trajectory";
  since?: string;
  agent?: string;
  tag?: string;
  kind?: string;
  set?: string;
  prompt?: string;
  config?: string;
  maxCost?: string;
  failOnRegression?: string;
  format: "table" | "json" | "md";
  output?: string;
  wait: boolean;
  yes: boolean;
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function filterFromOptions(opts: Pick<ReplayOptions, "since" | "agent" | "tag" | "kind" | "set">) {
  return {
    since: parseSince(opts.since),
    agent: opts.agent,
    tag: opts.tag,
    kind: opts.kind as "approve" | "edit" | "reject" | "escalate" | undefined,
    set: opts.set,
  };
}

export async function waitForJob(
  api: ReturnType<typeof apiFor>,
  id: string,
  onProgress?: (j: ReplayJob) => void,
): Promise<ReplayJob> {
  let last = -1;
  for (;;) {
    const job = await api.replays.get(id);
    if (job.completedCount !== last) {
      last = job.completedCount;
      onProgress?.(job);
    }
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function printSummary(job: ReplayJob): void {
  const s = job.summary;
  if (!s) return;
  const v = s.verdicts;
  const bits = [
    v.regression ? pc.red(`${v.regression} regressed`) : null,
    v.fixed ? pc.green(`${v.fixed} fixed`) : null,
    v.fail ? pc.yellow(`${v.fail} still wrong`) : null,
    v.pass ? pc.dim(`${v.pass} passed`) : null,
    v.unreplayable ? pc.magenta(`${v.unreplayable} unreplayable`) : null,
    v.error ? pc.red(`${v.error} errors`) : null,
  ].filter(Boolean);
  console.log(
    `${pc.bold(job.targetModel)}${job.targetPromptVersion ? ` · ${job.targetPromptVersion}` : ""}: ${s.completed}/${s.cases} cases, pass rate ${(s.passRate * 100).toFixed(1)}%, ${bits.join(", ")}, cost ${money(s.costUsd)}${s.stoppedByCostCap ? pc.yellow(" (stopped by --max-cost)") : ""}`,
  );
}

export function emitReport(report: ReplayReport, format: "table" | "json" | "md", output?: string): void {
  let text: string;
  if (format === "json") text = JSON.stringify(report, null, 2);
  else if (format === "md") text = renderMarkdownReport(report);
  else {
    const rows = [
      ...report.regressions,
      ...report.stillWrong,
      ...report.fixed,
      ...report.unreplayable,
      ...report.errors,
    ].map((r) => ({
      verdict: r.verdict,
      kind: r.kind,
      case: r.title.length > 50 ? `${r.title.slice(0, 47)}…` : r.title,
      baseline: short(r.baselineOutput),
      target: short(r.error ?? r.targetOutput),
      expected: short(r.kind === "approve" ? "(as baseline)" : r.expected),
      why: (r.reason ?? "").slice(0, 60),
    }));
    text = rows.length
      ? table(rows, ["verdict", "kind", "case", "baseline", "target", "expected", "why"])
      : pc.dim("no regressions, nothing still wrong, nothing fixed");
  }
  if (output) {
    writeFileSync(output, text);
    console.log(`${pc.green("✓")} wrote ${output}`);
  } else console.log(text);
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

export function registerReplay(program: Command): void {
  program
    .command("replay")
    .description(
      "Replay cases against a model (step mode on the server, trajectory mode through overturn.config.ts)",
    )
    .requiredOption(
      "--model <provider/model>",
      "e.g. openai/gpt-4.1-mini, anthropic/claude-sonnet-4-5, fake/fake-triage-weak",
    )
    .option("--mode <mode>", "step | trajectory", "step")
    .option("--since <when>", "Cases created since: 30d, 12h, or an ISO date")
    .option("--agent <name>", "Only cases from this agent")
    .option("--tag <tag>", "Only cases with this tag")
    .option("--kind <kind>", "approve | edit | reject | escalate")
    .option("--set <name>", "A saved case set")
    .option("--prompt <name@version>", "Replace the system prompt with a registered prompt version")
    .option("--config <file>", "overturn.config.ts to use in trajectory mode")
    .option("--max-cost <usd>", "Stop the job cleanly past this spend")
    .option("--fail-on-regression <n>", "Exit 1 when regressions exceed n (default 0 when set)")
    .option("--format <fmt>", "table | json | md", "table")
    .option("--output <file>", "Write the report to a file")
    .option("--no-wait", "Create the job and return (step mode)")
    .option("-y, --yes", "Skip the cost estimate confirmation")
    .action(async (opts: ReplayOptions, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const api = apiFor(global);
      const filter = filterFromOptions(opts);
      if (opts.mode !== "step" && opts.mode !== "trajectory") fail(`--mode must be step or trajectory`);
      const maxCostUsd = opts.maxCost !== undefined ? Number(opts.maxCost) : undefined;
      if (maxCostUsd !== undefined && !(maxCostUsd > 0)) fail("--max-cost must be a positive number");

      const estimate = await api.replays.estimate({ model: opts.model, filter });
      if (estimate.cases === 0) fail("No active cases match the filter.");
      if (!global.json && opts.format !== "json") {
        console.error(
          `${estimate.cases} cases · estimated ${estimate.priced ? money(estimate.estimatedCostUsd) : "cost unknown for this model"} (${estimate.estimatedInputTokens} in / ${estimate.estimatedOutputTokens} out tokens)${maxCostUsd !== undefined ? ` · cap ${money(maxCostUsd)}` : ""}`,
        );
      }
      if (
        !opts.yes &&
        process.stdin.isTTY &&
        estimate.estimatedCostUsd != null &&
        estimate.estimatedCostUsd > 1 &&
        maxCostUsd === undefined
      ) {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const a = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (a !== "y" && a !== "yes") fail("aborted", 2);
      }

      if (opts.mode === "trajectory") {
        const { runTrajectory } = await import("../trajectory.js");
        const job = await runTrajectory({
          api,
          model: opts.model,
          filter,
          maxCostUsd,
          promptVersion: opts.prompt,
          log: (m) => console.error(m),
        });
        return finish(api, job, opts, global);
      }

      const created = await api.replays.create({
        model: opts.model,
        mode: "step",
        filter,
        maxCostUsd,
        promptVersion: opts.prompt ?? null,
      });
      if (!opts.wait) {
        if (global.json) return printJson(created.job);
        console.log(
          `${pc.green("✓")} replay ${created.job.id} started (${created.job.caseCount} cases). Check with: overturn report ${created.job.id}`,
        );
        return;
      }
      const job = await waitForJob(api, created.job.id, (j) => {
        if (!global.json && opts.format !== "json")
          process.stderr.write(`\r${j.completedCount}/${j.caseCount} cases…`);
      });
      if (!global.json && opts.format !== "json") process.stderr.write("\n");
      return finish(api, job, opts, global);
    });

  program
    .command("report <jobId>")
    .description("Print a replay report (table, json or md)")
    .option("--format <fmt>", "table | json | md", "table")
    .option("--output <file>", "Write the report to a file")
    .action(
      async (jobId: string, opts: { format: "table" | "json" | "md"; output?: string }, cmd: Command) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        const api = apiFor(global);
        const job = await api.replays.get(jobId);
        const report = await api.replays.report(jobId);
        if (global.json) return printJson(report);
        if (opts.format === "table") printSummary(job);
        emitReport(report, opts.format, opts.output);
      },
    );

  const replays = program.command("replays").description("Replay jobs");
  replays
    .command("list")
    .option("--limit <n>", "Max rows", "20")
    .action(async (opts: { limit: string }, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const jobs = await apiFor(global).replays.list({ limit: Number(opts.limit) });
      if (global.json) return printJson(jobs);
      if (jobs.length === 0) return console.log(pc.dim("no replays"));
      console.log(
        table(
          jobs.map((j) => ({
            id: shortId(j.id),
            model: j.targetModel,
            prompt: j.targetPromptVersion ?? "",
            mode: j.mode,
            status: j.status,
            cases: `${j.completedCount}/${j.caseCount}`,
            regressions: j.summary?.verdicts.regression ?? "",
            fixed: j.summary?.verdicts.fixed ?? "",
            cost: money(j.costUsd),
            created: ago(j.createdAt),
          })),
          ["id", "model", "prompt", "mode", "status", "cases", "regressions", "fixed", "cost", "created"],
        ),
      );
    });

  const prompts = program
    .command("prompts")
    .description("Registered prompt versions (for --prompt name@version)");
  prompts
    .command("register <name@version> <file>")
    .description("Register a prompt template from a file")
    .action(async (ref: string, file: string, _o: unknown, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const at = ref.lastIndexOf("@");
      if (at <= 0) fail("use name@version");
      const { readFileSync } = await import("node:fs");
      const pv = await apiFor(global).prompts.register({
        name: ref.slice(0, at),
        version: ref.slice(at + 1),
        template: readFileSync(file, "utf8"),
      });
      console.log(`${pc.green("✓")} registered ${pv.name}@${pv.version} (${pv.hash.slice(0, 12)})`);
    });
  prompts.command("list").action(async (_o: unknown, cmd: Command) => {
    const global = cmd.optsWithGlobals<CliOptions>();
    const list = await apiFor(global).prompts.list();
    if (global.json) return printJson(list);
    if (list.length === 0) return console.log(pc.dim("no prompt versions"));
    console.log(
      table(
        list.map((p) => ({
          name: p.name,
          version: p.version,
          hash: p.hash.slice(0, 12),
          created: ago(p.createdAt),
        })),
        ["name", "version", "hash", "created"],
      ),
    );
  });
}

async function finish(
  api: ReturnType<typeof apiFor>,
  job: ReplayJob,
  opts: ReplayOptions,
  global: CliOptions,
): Promise<void> {
  if (job.status === "failed") fail(`replay ${job.id} failed: ${job.error ?? "unknown error"}`);
  const report = await api.replays.report(job.id);
  if (global.json) printJson(report);
  else {
    if (opts.format === "table") printSummary(job);
    emitReport(report, opts.format, opts.output);
  }
  if (opts.failOnRegression !== undefined) {
    const limit = Number(opts.failOnRegression);
    const n = report.regressions.length;
    if (n > limit) {
      console.error(pc.red(`${n} regression${n === 1 ? "" : "s"} (limit ${limit})`));
      process.exit(1);
    }
  }
}
