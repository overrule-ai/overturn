import type { Command } from "commander";
import pc from "picocolors";
import {
  ago,
  apiFor,
  type CliOptions,
  fail,
  parseSince,
  printJson,
  resolveId,
  shortId,
  table,
} from "../context.js";

const money = (n: number | null | undefined) =>
  n == null ? "—" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

/**
 * `overturn train` and `overturn models`: fine-tune an open-weight model on the project's
 * corrections, read the gate, run it in shadow, and promote it — by hand, always.
 */
export function registerModels(program: Command): void {
  program
    .command("train")
    .description("Fine-tune an open-weight model on your corrections; the suite gates the result")
    .requiredOption(
      "--base <model>",
      "Together base model, e.g. meta-llama/Meta-Llama-3.1-8B-Instruct-Reference",
    )
    .option("--method <m>", "sft | dpo", "sft")
    .option("--epochs <n>", "Training epochs", "3")
    .option("--agent <name>", "Only cases from this agent")
    .option("--tag <tag>", "Only cases with this tag")
    .option("--set <name>", "A saved case set")
    .option("--since <when>", "Cases created since: 30d, 12h, or an ISO date")
    .option("--name <name>", "Suffix for the trained model name")
    .option("--min-rows <n>", "Refuse to train under this many rows", "50")
    .option("--wait", "Poll until the gate has a verdict")
    .action(
      async (
        opts: {
          base: string;
          method: string;
          epochs: string;
          agent?: string;
          tag?: string;
          set?: string;
          since?: string;
          name?: string;
          minRows: string;
          wait?: boolean;
        },
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        if (opts.method !== "sft" && opts.method !== "dpo") fail("--method must be sft or dpo");
        const api = apiFor(global);
        let m = await api.models.create({
          baseModel: opts.base,
          method: opts.method,
          epochs: Number(opts.epochs),
          minRows: Number(opts.minRows),
          name: opts.name,
          filter: { agent: opts.agent, tag: opts.tag, set: opts.set, since: parseSince(opts.since) },
        });
        if (!global.json)
          console.error(
            `${pc.green("✓")} training ${pc.bold(m.name)} on ${m.baseModel}: ${m.datasetStats?.rows ?? "?"} ${m.method} rows${opts.wait ? "" : ` · overturn models get ${shortId(m.id)}`}`,
          );
        if (opts.wait) {
          const terminal = new Set(["passed", "failed", "promoted", "retired"]);
          while (!terminal.has(m.status)) {
            await new Promise((r) => setTimeout(r, 15_000));
            m = await api.models.get(m.id);
            if (!global.json) console.error(pc.dim(`  ${m.status}…`));
          }
        }
        if (global.json) return printJson(m);
        printModel(m);
      },
    );

  const models = program
    .command("models")
    .description("Owned models: trained on corrections, gated by the suite");
  models
    .command("list")
    .description("List trained models")
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const list = await apiFor(global).models.list();
      if (global.json) return printJson(list);
      if (list.length === 0)
        return console.log(pc.dim("No models yet. overturn train --base <model> starts one."));
      console.log(
        table(
          list.map((m) => ({
            id: shortId(m.id),
            name: m.name,
            base: m.baseModel,
            status: m.status,
            gate: m.gate ? (m.gate.pass ? "green" : "red") : "",
            "pass rate": pct(m.gate?.passRate),
            incumbent: pct(m.gate?.incumbentPassRate),
            shadow: m.shadowStats
              ? `${m.shadowStats.runs} runs · ${pct(m.shadowStats.passRate)}`
              : m.shadow
                ? "on"
                : "",
            cost: money(m.trainingCostUsd),
            created: ago(m.createdAt),
          })),
          ["id", "name", "base", "status", "gate", "pass rate", "incumbent", "shadow", "cost", "created"],
        ),
      );
    });
  models
    .command("get <id>")
    .description("A model's gate and shadow results")
    .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const api = apiFor(global);
      const full = await resolveId(id, () => api.models.list(), "model");
      const m = await api.models.get(full);
      if (global.json) return printJson(m);
      printModel(m);
    });
  for (const [verb, help] of [
    ["promote", "Promote a model that passed the gate (a human decision)"],
    ["retire", "Retire a model; clears the promotion if it held it"],
  ] as const) {
    models
      .command(`${verb} <id>`)
      .description(help)
      .action(async (id: string, _opts: Record<string, never>, cmd: Command) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        const api = apiFor(global);
        const full = await resolveId(id, () => api.models.list(), "model");
        const m = await api.models[verb](full);
        if (global.json) return printJson(m);
        console.log(
          `${pc.green("✓")} ${m.name} is ${m.status}${m.status === "promoted" ? ` · ov.promotedModel() → ${m.servedAs}` : ""}`,
        );
      });
  }
  models
    .command("shadow <id>")
    .description("Turn shadow mode on or off: the model answers live runs beside production, serving nothing")
    .option("--off", "Turn shadow mode off")
    .action(async (id: string, opts: { off?: boolean }, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const api = apiFor(global);
      const full = await resolveId(id, () => api.models.list(), "model");
      const m = await api.models.patch(full, { shadow: !opts.off });
      if (global.json) return printJson(m);
      console.log(`${pc.green("✓")} shadow ${m.shadow ? "on" : "off"} for ${m.name}`);
    });
  models
    .command("deploy <id>")
    .description(
      "Create the dedicated endpoint that serves a trained model on Together (needs TOGETHER_PROJECT_ID on the server); the gate runs when it is ready",
    )
    .option("--dry-run", "Show the plan (hardware, config) without creating anything")
    .option("--config <id>", "Together config revision to use instead of the cheapest certified one")
    .option("--replicas <n>", "Replicas", "1")
    .action(
      async (id: string, opts: { dryRun?: boolean; config?: string; replicas: string }, cmd: Command) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        const api = apiFor(global);
        const full = await resolveId(id, () => api.models.list(), "model");
        const r = await api.models.deploy(full, {
          dryRun: Boolean(opts.dryRun),
          config: opts.config,
          replicas: Number(opts.replicas),
        });
        if (global.json) return printJson(r);
        if ("dryRun" in r) {
          console.log(
            `${pc.bold("plan")}  ${r.togetherModel}${r.adapter ? " (LoRA adapter on its base)" : ""}\n  deploys  ${r.deploys}\n  config   ${r.config}\n  hardware ${r.hardware.map((h) => `${h.key}=${h.value}`).join(" ") || "(provider default)"}\n  replicas ${r.replicas}\n${pc.dim("nothing was created; run without --dry-run to provision (billed by Together per GPU-hour)")}`,
          );
          return;
        }
        printModel(r);
      },
    );
  models
    .command("auto")
    .description(
      "Continuous retraining: once --min-new-rows new corrections arrive, train on them, gate, shadow if it passes, notify. Never promotes.",
    )
    .option("--base <model>", "Together base model id (required to turn on)")
    .option("--min-new-rows <n>", "New training rows before another model is trained", "100")
    .option("--agent <name>", "Only this agent's corrections")
    .option("--no-shadow", "Do not put a passing model in shadow mode")
    .option("--off", "Turn continuous retraining off")
    .action(
      async (
        opts: { base?: string; minNewRows: string; agent?: string; shadow: boolean; off?: boolean },
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<CliOptions>();
        const api = apiFor(global);
        if (!opts.off && !opts.base)
          throw new Error("--base <model> is required to turn continuous retraining on");
        const p = await api.project.patch({
          settings: {
            retrain: {
              enabled: !opts.off,
              baseModel: opts.base ?? null,
              minNewRows: Number(opts.minNewRows),
              agent: opts.agent ?? null,
              shadowOnPass: opts.shadow,
            },
          },
        });
        if (global.json) return printJson(p.settings.retrain);
        const r = p.settings.retrain;
        console.log(
          r.enabled
            ? `${pc.green("✓")} continuous retraining on: ${r.baseModel}, every ${r.minNewRows} new rows${r.agent ? ` for ${r.agent}` : ""}${r.shadowOnPass ? ", shadow on pass" : ""}`
            : `${pc.green("✓")} continuous retraining off`,
        );
      },
    );
  models
    .command("serve <id> <provider/model>")
    .description(
      "Set where the trained weights answer from (when the provider needs a dedicated endpoint); re-runs the gate",
    )
    .action(async (id: string, servedAs: string, _opts: Record<string, never>, cmd: Command) => {
      const global = cmd.optsWithGlobals<CliOptions>();
      const api = apiFor(global);
      const full = await resolveId(id, () => api.models.list(), "model");
      const m = await api.models.patch(full, { servedAs });
      if (global.json) return printJson(m);
      printModel(m);
    });
}

function printModel(m: import("@overturn-ai/shared").TrainedModel): void {
  console.log(`${pc.bold(m.name)}  ${m.baseModel} · ${m.method} · ${m.epochs} epochs · ${m.status}`);
  if (m.datasetStats)
    console.log(
      `  dataset: ${m.datasetStats.rows} rows (${Object.entries(m.datasetStats.byKind)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ")}), ~${m.datasetStats.approxTokens.toLocaleString()} tokens`,
    );
  if (m.servedAs) console.log(`  served as: ${m.servedAs}`);
  if (m.trainingCostUsd != null) console.log(`  training cost: ${money(m.trainingCostUsd)}`);
  if (m.gate)
    console.log(
      `  gate: ${m.gate.pass ? pc.green("green") : pc.red("red")} · pass rate ${pct(m.gate.passRate)}${m.gate.incumbentModel ? ` vs ${m.gate.incumbentModel} ${pct(m.gate.incumbentPassRate)}` : ""} · ${m.gate.regressions} regressions · ${m.gate.newPaths} new paths${m.gate.reasons.length ? ` · ${m.gate.reasons.join("; ")}` : ""}`,
    );
  if (m.shadowStats)
    console.log(
      `  shadow: ${m.shadowStats.runs} live runs · agrees with production ${m.shadowStats.runs ? pct(m.shadowStats.agreesWithProduction / m.shadowStats.runs) : "—"} · matches humans ${pct(m.shadowStats.passRate)} (${m.shadowStats.scored} corrected)${m.shadowStats.errors ? ` · ${m.shadowStats.errors} errors` : ""}`,
    );
  if (m.error) console.log(`  ${pc.red(m.error)}`);
  if (m.status === "passed")
    console.log(
      pc.dim(
        `  overturn models shadow ${shortId(m.id)}   # watch it on live traffic\n  overturn models promote ${shortId(m.id)}  # when you're sure`,
      ),
    );
}
