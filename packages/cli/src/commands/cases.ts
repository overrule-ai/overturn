import type { Command } from "commander";
import pc from "picocolors";
import {
  ago,
  apiFor,
  type CliOptions,
  parseSince,
  printJson,
  resolveId,
  shortId,
  table,
} from "../context.js";

export function registerCases(program: Command): void {
  const cases = program.command("cases").description("Regression cases made from corrections");

  cases
    .command("dedupe")
    .description("Merge cases that share input, kind and answer into one (the oldest keeps the count)")
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const r = await apiFor(global).cases.dedupe();
      if (global.json) return printJson(r);
      console.log(
        r.merged === 0
          ? pc.dim("no duplicate cases")
          : `merged ${r.merged} duplicate case${r.merged === 1 ? "" : "s"} into ${r.kept}`,
      );
    });

  cases
    .command("list")
    .description("List cases")
    .option("--agent <name>", "Filter by agent")
    .option("--tag <tag>", "Filter by tag")
    .option("--kind <kind>", "approve | edit | reject | escalate")
    .option("--set <name>", "Saved case set")
    .option("--status <status>", "active | archived", "active")
    .option("--since <when>", "30d, 12h, 90m or an ISO date")
    .option("--limit <n>", "Max rows", "100")
    .action(
      async (
        opts: {
          agent?: string;
          tag?: string;
          kind?: string;
          set?: string;
          status: string;
          since?: string;
          limit: string;
        },
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        const page = await apiFor(global).cases.list({
          agent: opts.agent,
          tag: opts.tag,
          kind: opts.kind as "approve" | "edit" | "reject" | "escalate" | undefined,
          set: opts.set,
          status: opts.status as "active" | "archived",
          since: parseSince(opts.since),
          limit: Number(opts.limit),
        });
        if (global.json) return printJson(page);
        if (page.items.length === 0) return console.log(pc.dim("no cases"));
        console.log(
          table(
            page.items.map((c) => ({
              id: shortId(c.id),
              kind: c.kind,
              agent: c.agent,
              scorer: c.scorer,
              verdict: c.lastVerdict ?? "",
              title: c.title.length > 60 ? `${c.title.slice(0, 57)}…` : c.title,
              created: ago(c.createdAt),
            })),
            ["id", "kind", "agent", "scorer", "verdict", "title", "created"],
          ),
        );
        if (page.nextCursor) console.log(pc.dim("… more (raise --limit)"));
      },
    );

  cases
    .command("get <id>")
    .description("Show a case: frozen input, expected, tool recordings")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const api = apiFor(global);
      const c = await api.cases.get(
        await resolveId(id, async () => (await api.cases.list({ limit: 200 })).items, "case"),
      );
      if (global.json) return printJson(c);
      console.log(
        `${pc.bold(c.title)}\n${pc.dim(c.id)}  ${c.kind}  scorer=${c.scorer}  model=${c.recordedModel ?? "?"}  tools=${Object.keys(c.toolRecordings).length}${c.truncated ? pc.yellow("  truncated") : ""}`,
      );
      console.log(`\n${pc.bold("expected")}\n${JSON.stringify(c.expected, null, 2)}`);
      console.log(`\n${pc.bold("original")}\n${JSON.stringify(c.originalOutput, null, 2)}`);
    });

  cases
    .command("archive <id>")
    .description("Archive a case")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const api = apiFor(global);
      await api.cases.patch(
        await resolveId(id, async () => (await api.cases.list({ limit: 200 })).items, "case"),
        {
          status: "archived",
        },
      );
      console.log(`${pc.green("✓")} archived ${id}`);
    });
}
