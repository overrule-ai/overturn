import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import pc from "picocolors";
import { apiFor, type CliOptions, fail, parseSince, printJson } from "../context.js";

/**
 * `overturn export`: the project's corrections as a fine-tuning dataset.
 *   sft  — prompt -> human-approved answer (approve + edit cases), OpenAI chat JSONL
 *   dpo  — prompt, chosen (corrected) and rejected (the agent's original), from edit cases
 * The row format is what Together, OpenAI and HF trl accept as-is.
 */
export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export corrections as a fine-tuning dataset (JSONL)")
    .option("--format <fmt>", "sft | dpo", "sft")
    .option("--agent <name>", "Only cases from this agent")
    .option("--tag <tag>", "Only cases with this tag")
    .option("--set <name>", "A saved case set")
    .option("--since <when>", "Cases created since: 30d, 12h, or an ISO date")
    .option("--no-approved", "sft: leave out approved cases, keep only edits")
    .option("--output <file>", "Write the JSONL here (default: stdout)")
    .option("--stats", "Only print what the export would contain")
    .action(
      async (
        opts: {
          format: string;
          agent?: string;
          tag?: string;
          set?: string;
          since?: string;
          approved: boolean;
          output?: string;
          stats?: boolean;
        },
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        if (opts.format !== "sft" && opts.format !== "dpo") fail("--format must be sft or dpo");
        const api = apiFor(global);
        const q = {
          format: opts.format as "sft" | "dpo",
          agent: opts.agent,
          tag: opts.tag,
          set: opts.set,
          since: opts.since ? parseSince(opts.since) : undefined,
          includeApproved: opts.approved,
        };
        const stats = await api.export.stats(q);
        if (opts.stats || stats.rows === 0) {
          if (global.json) return printJson(stats);
          const kinds = Object.entries(stats.byKind)
            .map(([k, n]) => `${n} ${k}`)
            .join(", ");
          console.log(
            `${pc.bold(String(stats.rows))} ${opts.format} rows (${kinds || "none"}), ${stats.skipped} cases skipped, ~${stats.approxTokens.toLocaleString()} tokens`,
          );
          if (stats.rows === 0)
            console.log(
              pc.dim(
                opts.format === "dpo"
                  ? "dpo needs edit cases: a corrected answer (chosen) and the agent's original (rejected)."
                  : "sft needs approve or edit cases with an answer.",
              ),
            );
          return;
        }
        const { text, rows } = await api.export.jsonl(q);
        if (opts.output) {
          writeFileSync(opts.output, text);
          console.error(`${pc.green("✓")} wrote ${rows} rows to ${opts.output}`);
        } else process.stdout.write(text);
      },
    );
}
