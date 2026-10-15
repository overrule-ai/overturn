import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { OverturnApi } from "@overturn/sdk";
import type { Command } from "commander";
import pc from "picocolors";
import { fail, loadDotEnv } from "../context.js";

const CONFIG_TEMPLATE = `import { defineConfig } from "overturn";

/**
 * Overturn trajectory replay entry point. \`agent\` is called with a case's
 * original input while the SDK is in replay mode: every ov.tool() answers
 * from the recording and side-effect tools are refused.
 */
export default defineConfig({
  agent: async (input, ctx) => {
    // import your agent and run it, e.g.
    // const { triage } = await import("./src/agent");
    // return triage(input as Ticket);
    throw new Error("overturn.config.ts: implement agent()");
  },
  maxSteps: 50,
});
`;

async function ask(question: string, fallback: string | undefined): Promise<string> {
  if (!process.stdin.isTTY) return fallback ?? "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${fallback ? pc.dim(` (${fallback})`) : ""}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Write overturn.config.ts and .env entries, then verify the API key")
    .option("--no-config", "Do not write overturn.config.ts")
    .action(async (local: { config: boolean }, cmd: Command) => {
      const opts = { ...cmd.optsWithGlobals<{ apiKey?: string; baseUrl?: string }>(), config: local.config };
      loadDotEnv();
      const apiKey =
        opts.apiKey ?? process.env.OVERTURN_API_KEY ?? (await ask("Overturn API key", undefined));
      const baseUrl =
        opts.baseUrl ??
        process.env.OVERTURN_BASE_URL ??
        (await ask("Overturn API URL", "https://api.overturn.run"));
      if (!apiKey)
        fail(
          "An API key is required (create one in Settings → API keys, or run `pnpm bootstrap` on a self-hosted install).",
        );

      const api = new OverturnApi({ apiKey, baseUrl, userAgent: "overturn-cli/0.1.0" });
      let projectName: string;
      try {
        const me = await api.me();
        projectName = me.project.name;
      } catch (err) {
        fail(
          `Could not verify the key against ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const envPath = path.join(process.cwd(), ".env");
      const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      const lines = existing.split("\n").filter((l) => !/^OVERTURN_(API_KEY|BASE_URL)=/.test(l));
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`OVERTURN_API_KEY=${apiKey}`, `OVERTURN_BASE_URL=${baseUrl}`, "");
      writeFileSync(envPath, lines.join("\n"));
      console.log(`${pc.green("✓")} wrote ${pc.bold(".env")} (OVERTURN_API_KEY, OVERTURN_BASE_URL)`);

      if (opts.config) {
        const cfgPath = path.join(process.cwd(), "overturn.config.ts");
        if (existsSync(cfgPath)) {
          console.log(`${pc.dim("·")} overturn.config.ts already exists, left as is`);
        } else {
          writeFileSync(cfgPath, CONFIG_TEMPLATE);
          console.log(
            `${pc.green("✓")} wrote ${pc.bold("overturn.config.ts")} (trajectory replay entry point)`,
          );
        }
      }
      const gi = path.join(process.cwd(), ".gitignore");
      if (
        existsSync(gi) &&
        !readFileSync(gi, "utf8")
          .split("\n")
          .some((l) => l.trim() === ".env")
      ) {
        console.log(pc.yellow("! .env is not in .gitignore — add it so the key is never committed"));
      }
      console.log(`${pc.green("✓")} key verified for project ${pc.bold(projectName)} at ${baseUrl}`);
    });
}
