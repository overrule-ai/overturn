import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerCases } from "./commands/cases.js";
import { registerInit } from "./commands/init.js";
import { registerReplay } from "./commands/replay.js";
import { registerRuns } from "./commands/runs.js";

export { defineConfig, type OverturnConfig, type ReplayContext } from "./config.js";
export { findConfig, loadConfig, runTrajectory } from "./trajectory.js";

export function buildProgram(): Command {
  const program = new Command("overturn")
    .description("Every time a human corrects your agent, it becomes a test.")
    .version("0.1.0")
    .option("--api-key <key>", "API key (default: OVERTURN_API_KEY)")
    .option("--base-url <url>", "API base URL (default: OVERTURN_BASE_URL)")
    .option("--json", "Print JSON instead of tables")
    .showHelpAfterError();
  registerInit(program);
  registerRuns(program);
  registerCases(program);
  registerReplay(program);
  return program;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const href = pathToFileURL(realpathSync(entry)).href;
    return href === import.meta.url || /\/bin\/overturn\.js$/.test(href);
  } catch {
    return false;
  }
}

if (isMain()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
