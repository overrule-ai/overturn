import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { OverturnApi } from "@overturn-ai/sdk";
import pc from "picocolors";
import { VERSION } from "./version.js";

export interface CliOptions {
  apiKey?: string;
  baseUrl?: string;
  json?: boolean;
}

/** Loads .env from cwd upward (3 levels) without overriding the environment. */
export function loadDotEnv(cwd = process.cwd()): void {
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
        if (!m) continue;
        const key = m[1]!;
        let value = m[2]!;
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
          value = value.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function resolveConnection(opts: CliOptions): { apiKey: string; baseUrl: string } {
  loadDotEnv();
  const apiKey = opts.apiKey ?? process.env.OVERTURN_API_KEY ?? "";
  const baseUrl = opts.baseUrl ?? process.env.OVERTURN_BASE_URL ?? "https://api.overturn.run";
  if (!apiKey) {
    fail("No API key. Set OVERTURN_API_KEY (run `overturn init`) or pass --api-key.");
  }
  return { apiKey, baseUrl };
}

export function apiFor(opts: CliOptions): OverturnApi {
  const { apiKey, baseUrl } = resolveConnection(opts);
  return new OverturnApi({ apiKey, baseUrl, userAgent: `overturn-cli/${VERSION}` });
}

export function fail(message: string, code = 1): never {
  console.error(pc.red(`error: ${message}`));
  process.exit(code);
}

export function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

/** Parses "30d", "12h", "90m", "2026-10-01" into an ISO timestamp. */
export function parseSince(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([dhm])$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "d" ? n * 86_400_000 : m[2] === "h" ? n * 3_600_000 : n * 60_000;
    return new Date(Date.now() - ms).toISOString();
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail(`Invalid --since "${v}". Use 30d, 12h, 90m or an ISO date.`);
  return d.toISOString();
}

export function table(
  rows: Array<Record<string, string | number | null | undefined>>,
  columns: string[],
): string {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const out = [pc.bold(line(columns)), ...rows.map((r) => line(columns.map((c) => String(r[c] ?? ""))))];
  return out.join("\n");
}

export function shortId(id: string): string {
  return id.slice(-8);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Commands print 8-character ids (the UUID's tail); accept those back by looking them up
 * among recent items. A full UUID passes through untouched.
 */
export async function resolveId(
  id: string,
  list: () => Promise<{ id: string }[]>,
  what: string,
): Promise<string> {
  if (UUID.test(id)) return id;
  const needle = id.toLowerCase();
  const matches = (await list()).filter((x) => x.id.endsWith(needle));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) return fail(`No recent ${what} matches "${id}"; pass the full id`);
  return fail(`"${id}" matches ${matches.length} recent ${what}s; pass the full id`);
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}
