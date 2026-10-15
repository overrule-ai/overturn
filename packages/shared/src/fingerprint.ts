import { sha256Hex } from "./sha256.js";

/**
 * Fingerprint contract (see docs/fingerprint.md). This file is the single
 * implementation used by recording and replay in every SDK; the Python SDK
 * mirrors it byte for byte and is tested against the same vectors.
 *
 *   fingerprint = sha256(kind + "\n" + name + "\n" + canonicalJSON(args'))
 *
 * where args' is args after applying `matchOn` (keep only these top-level keys)
 * or, when no matchOn is set, `ignoreArgs` (drop these top-level keys).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface FingerprintOptions {
  /** Keep only these top-level argument keys. Wins over ignoreArgs. */
  matchOn?: readonly string[];
  /** Drop these top-level argument keys (timestamps, request ids). */
  ignoreArgs?: readonly string[];
}

export const FINGERPRINT_VERSION = 1;

function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) return "null";
  if (Object.is(n, -0)) return "0";
  // Shortest round-trip representation; integers never carry a fraction.
  return Number.isInteger(n) ? n.toFixed(0) : String(n);
}

function canonicalString(s: string): string {
  return JSON.stringify(s.trim());
}

/**
 * Canonical JSON: keys sorted recursively, null/undefined dropped (in objects
 * and arrays), strings trimmed, numbers normalized, arrays kept in order.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return canonicalString(value.toISOString());
  if (Array.isArray(value)) {
    const items = value.filter((v) => v !== null && v !== undefined).map((v) => canonicalJSON(v));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== null && obj[k] !== undefined && typeof obj[k] !== "function")
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  // functions, symbols
  return "null";
}

export function selectArgs(args: unknown, options: FingerprintOptions = {}): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const obj = args as Record<string, unknown>;
  if (options.matchOn && options.matchOn.length > 0) {
    const out: Record<string, unknown> = {};
    for (const key of options.matchOn) if (key in obj) out[key] = obj[key];
    return out;
  }
  if (options.ignoreArgs && options.ignoreArgs.length > 0) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) if (!options.ignoreArgs.includes(key)) out[key] = obj[key];
    return out;
  }
  return obj;
}

export function fingerprint(
  kind: string,
  name: string,
  args: unknown,
  options: FingerprintOptions = {},
): string {
  const canonical = canonicalJSON(selectArgs(args, options));
  return sha256Hex(`${kind}\n${name}\n${canonical}`);
}

/** Fingerprint of a tool call: kind is always "tool_call". */
export function toolFingerprint(name: string, args: unknown, options: FingerprintOptions = {}): string {
  return fingerprint("tool_call", name, args, options);
}

/** Stable hash of an arbitrary JSON value, used for replay caches. */
export function hashJSON(value: unknown): string {
  return sha256Hex(canonicalJSON(value));
}
