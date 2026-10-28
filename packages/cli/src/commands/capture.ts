import { readFileSync } from "node:fs";
import type { CaptureCreate } from "@overturn-ai/shared";
import { captureCreateSchema } from "@overturn-ai/shared";
import type { Command } from "commander";
import pc from "picocolors";
import { apiFor, type CliOptions, printJson, shortId } from "../context.js";

function readText(spec: string): string {
  // "@file" reads a file; "-" reads stdin; anything else is the text itself.
  if (spec === "-") return readFileSync(0, "utf8");
  if (spec.startsWith("@")) return readFileSync(spec.slice(1), "utf8");
  return spec;
}

export function registerCapture(program: Command): void {
  program
    .command("capture")
    .description("Capture a correction made where the expert works: the draft, what was sent, and why")
    .requiredOption("--external-id <id>", 'The record in the source system, e.g. "zd:48213"')
    .requiredOption("--draft <text>", "What the AI or junior produced (@file or - for stdin)")
    .requiredOption("--sent <text>", "What the expert actually sent (@file or - for stdin)")
    .option("--agent <name>", "Workflow, one suite per agent", "reply")
    .option("--source <name>", "zendesk | front | intercom | gmail | salesforce | custom", "custom")
    .option("--reason <text>", "One line on why it changed")
    .option("--actor <who>", "The expert, e.g. their email")
    .option("--subject <text>", "Thread subject")
    .option("--context <file>", "JSON file: [{role, author?, content, at?}] oldest first")
    .option("--fields <json>", 'Decision fields on the sent answer, e.g. \'{"status":"denied"}\'')
    .option("--draft-fields <json>", "Decision fields on the draft")
    .option("--draft-model <model>", "Which model wrote the draft")
    .option("--url <url>", "Link back to the record")
    .action(
      async (
        opts: {
          externalId: string;
          draft: string;
          sent: string;
          agent: string;
          source: string;
          reason?: string;
          actor?: string;
          subject?: string;
          context?: string;
          fields?: string;
          draftFields?: string;
          draftModel?: string;
          url?: string;
        },
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        const body: CaptureCreate = captureCreateSchema.parse({
          externalId: opts.externalId,
          agent: opts.agent,
          source: opts.source,
          actor: opts.actor,
          subject: opts.subject,
          reason: opts.reason,
          draftModel: opts.draftModel,
          url: opts.url,
          context: opts.context ? JSON.parse(readFileSync(opts.context, "utf8")) : [],
          draft: {
            text: readText(opts.draft),
            ...(opts.draftFields ? { fields: JSON.parse(opts.draftFields) } : {}),
          },
          sent: { text: readText(opts.sent), ...(opts.fields ? { fields: JSON.parse(opts.fields) } : {}) },
        });
        const r = await apiFor(global).corrections.capture(body);
        if (global.json) return printJson(r);
        const what = r.changed
          ? `${pc.yellow("edit")}${r.changedFields.length ? ` (${r.changedFields.join(", ")})` : ""}`
          : pc.green("approve");
        console.log(
          `${what}  case ${r.case ? shortId(r.case.id) : "-"}${r.deduplicated ? pc.dim("  (already in the suite)") : ""}`,
        );
      },
    );
}
