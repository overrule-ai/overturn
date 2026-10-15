import { existsSync } from "node:fs";
import path from "node:path";

/** Loads the nearest .env (cwd, then repo root) without overriding variables already set. Silent when absent. */
export function loadDotEnv(): void {
  const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../../../.env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const before = { ...process.env };
    try {
      process.loadEnvFile(file);
    } catch {
      return;
    }
    // loadEnvFile does not override existing vars; restore to be explicit anyway
    for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
    return;
  }
}
