import type { Command } from "commander";
import pc from "picocolors";
import { ago, apiFor, type CliOptions, parseSince, printJson, shortId, table } from "../context.js";

export function registerRuns(program: Command): void {
  const runs = program.command("runs").description("Recorded agent runs");

  runs
    .command("list")
    .description("List runs")
    .option("--agent <name>", "Filter by agent")
    .option("--tag <tag>", "Filter by tag")
    .option("--status <status>", "running | completed | failed")
    .option("--corrected", "Only runs with corrections")
    .option("--since <when>", "30d, 12h, 90m or an ISO date")
    .option("--limit <n>", "Max rows", "50")
    .action(
      async (
        opts: {
          agent?: string;
          tag?: string;
          status?: string;
          corrected?: boolean;
          since?: string;
          limit: string;
        },
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        const api = apiFor(global);
        const page = await api.runs.list({
          agent: opts.agent,
          tag: opts.tag,
          status: opts.status as "running" | "completed" | "failed" | undefined,
          corrected: opts.corrected ? "true" : undefined,
          since: parseSince(opts.since),
          limit: Number(opts.limit),
        });
        if (global.json) return printJson(page);
        if (page.items.length === 0) return console.log(pc.dim("no runs"));
        console.log(
          table(
            page.items.map((r) => ({
              id: shortId(r.id),
              agent: r.agent,
              version: r.agentVersion ?? "",
              status: r.status,
              steps: r.stepCount,
              corrections: r.correctionCount,
              external: r.externalId ?? "",
              started: ago(r.startedAt),
            })),
            ["id", "agent", "version", "status", "steps", "corrections", "external", "started"],
          ),
        );
        if (page.nextCursor) console.log(pc.dim(`… more (raise --limit)`));
      },
    );

  runs
    .command("get <id>")
    .description("Show a run with its steps")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const run = await apiFor(global).runs.get(id);
      if (global.json) return printJson(run);
      console.log(`${pc.bold(run.agent)} ${run.agentVersion ?? ""} ${pc.dim(run.id)} ${run.status}`);
      for (const s of run.steps) {
        const extra =
          s.kind === "llm_call" ? pc.dim(s.model ?? "") : s.sideEffect ? pc.yellow("side-effect") : "";
        console.log(
          `  ${String(s.seq).padStart(3)}  ${s.kind.padEnd(9)} ${s.name.padEnd(24)} ${extra} ${s.latencyMs != null ? pc.dim(`${Math.round(s.latencyMs)}ms`) : ""}`,
        );
      }
    });
}
