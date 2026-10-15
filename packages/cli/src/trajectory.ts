/**
 * Trajectory replay: loads overturn.config.ts, puts the SDK in replay mode with each
 * case's tool recordings and the target model, calls agent(input, ctx) and posts the
 * results to the job. Tools never execute: unseen fingerprints and side-effect tools
 * end the case as unreplayable (see @overturn-ai/sdk replay guarantees).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MaxStepsExceededError,
  Overturn,
  type OverturnApi,
  type ReplayJob,
  type ReplayModelInput,
  type ReplayModelOutput,
  SideEffectRefusedError,
  UnreplayableError,
} from "@overturn-ai/sdk";
import { type Case, extractAnswer, type ReplayResultPost } from "@overturn-ai/shared";
import type { OverturnConfig } from "./config.js";

export interface TrajectoryOptions {
  api: OverturnApi;
  model: string;
  filter: Record<string, unknown>;
  maxCostUsd?: number;
  promptVersion?: string;
  configPath?: string;
  log: (message: string) => void;
}

const CONFIG_NAMES = [
  "overturn.config.ts",
  "overturn.config.mts",
  "overturn.config.js",
  "overturn.config.mjs",
];

export function findConfig(cwd = process.cwd(), explicit?: string): string {
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    if (!existsSync(p)) throw new Error(`Config not found: ${p}`);
    return p;
  }
  for (const name of CONFIG_NAMES) {
    const p = path.join(cwd, name);
    if (existsSync(p)) return p;
  }
  throw new Error(`No overturn.config.ts in ${cwd}. Run \`overturn init\` to create one.`);
}

export async function loadConfig(file: string): Promise<OverturnConfig> {
  let mod: Record<string, unknown>;
  if (/\.[cm]?ts$/.test(file)) {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    mod = (await jiti.import(file)) as Record<string, unknown>;
  } else {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  }
  const cfg = (mod.default ?? mod) as Partial<OverturnConfig>;
  if (typeof cfg.agent !== "function") throw new Error(`${file} must export default defineConfig({ agent })`);
  return cfg as OverturnConfig;
}

export async function runTrajectory(opts: TrajectoryOptions): Promise<ReplayJob> {
  const configFile = findConfig(process.cwd(), opts.configPath);
  const config = await loadConfig(configFile);
  const created = await opts.api.replays.create({
    model: opts.model,
    mode: "trajectory",
    filter: opts.filter,
    maxCostUsd: opts.maxCostUsd,
    promptVersion: opts.promptVersion ?? null,
    start: false,
  });
  const job = created.job;
  opts.log(
    `replay ${job.id}: ${created.caseIds.length} cases, trajectory mode via ${path.basename(configFile)}`,
  );

  // One SDK instance owns replay mode; the agent's own instances see the same global state.
  const ov = new Overturn({ enabled: false });
  const modelCall = async (input: ReplayModelInput): Promise<ReplayModelOutput> =>
    opts.api.request("POST", "/v1/replays/model", {
      model: opts.model,
      promptVersion: opts.promptVersion ?? null,
      input,
    });

  let spent = 0;
  let stopped = false;
  const batch: ReplayResultPost[] = [];
  const flush = async (finish: boolean, error?: string) => {
    if (batch.length === 0 && !finish) return;
    if (batch.length === 0) {
      await opts.api.replays.postResults(job.id, {
        results: [{ caseId: created.caseIds[0]!, error: "no results" }],
        finish: true,
        error: error ?? "no cases ran",
      });
      return;
    }
    await opts.api.replays.postResults(job.id, { results: batch.splice(0), finish, error: error ?? null });
  };

  let done = 0;
  for (const caseId of created.caseIds) {
    if (opts.maxCostUsd !== undefined && spent >= opts.maxCostUsd) {
      stopped = true;
      break;
    }
    const c: Case = await opts.api.cases.get(caseId);
    const run = await opts.api.runs.get(c.runId);
    const t0 = Date.now();
    const state = ov.replayMode(c.toolRecordings, { modelCall, maxSteps: config.maxSteps ?? 50 });
    const result: ReplayResultPost = { caseId };
    // An ambient run so the agent's wrapped clients and tools record steps into the replay state
    // (nothing is sent to the API while in replay mode).
    const replayRun = ov.startRun({ agent: c.agent, input: run.input, tags: ["replay"] });
    try {
      const output = await replayRun.context(() =>
        config.agent(run.input, {
          caseId,
          runId: c.runId,
          model: opts.model,
          promptVersion: opts.promptVersion,
        }),
      );
      result.output = output === undefined ? null : output;
    } catch (err) {
      if (err instanceof UnreplayableError)
        result.unreplayable = { toolName: err.toolName, args: err.args, reason: "unseen" };
      else if (err instanceof SideEffectRefusedError) {
        // The trajectory ends at the first side-effect tool. The answer under test is what the
        // agent decided before it: the last model answer, or the refused call itself as a tool decision.
        result.refusedSideEffects = [{ toolName: err.toolName, args: err.args }];
        const lastLlm = [...state.steps].reverse().find((s) => s.kind === "llm_call");
        result.output =
          c.scorer === "tool_choice" || !lastLlm
            ? { tool_calls: [{ name: err.toolName, args: err.args }] }
            : extractAnswer(lastLlm.output);
      } else if (err instanceof MaxStepsExceededError) result.error = err.message;
      else result.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    } finally {
      ov.exitReplayMode();
    }
    result.latencyMs = Date.now() - t0;
    result.costUsd = state.steps.reduce((n, s) => n + (s.costUsd ?? 0), 0);
    spent += result.costUsd;
    result.steps = state.steps.map((s) => ({
      kind: s.kind,
      name: s.name,
      model: s.model ?? null,
      latencyMs: s.latencyMs ?? null,
      error: s.error ?? null,
    }));
    batch.push(result);
    done++;
    process.stderr.write(`\r${done}/${created.caseIds.length} cases…`);
    if (batch.length >= 25) await flush(false);
  }
  process.stderr.write("\n");
  await flush(true, stopped ? "stopped by --max-cost" : undefined);
  return opts.api.replays.get(job.id);
}
