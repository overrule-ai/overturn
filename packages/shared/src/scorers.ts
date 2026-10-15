import { JSONPath } from "jsonpath-plus";
import { isToolDecision } from "./cases.js";
import { canonicalJSON, toolFingerprint } from "./fingerprint.js";
import type { CorrectionKind, ScorerName } from "./schemas.js";

export interface ScoreResult {
  score: number;
  passed: boolean;
  reason: string;
}

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

/** Model access the scorers need; provided by the replay engine (and mocked in tests). */
export interface ScorerContext {
  embed?: (text: string) => Promise<number[]>;
  judge?: (prompt: string) => Promise<JudgeVerdict>;
}

export interface ScoreInput {
  scorer: ScorerName;
  config: Record<string, unknown>;
  expected: unknown;
  actual: unknown;
  kind?: CorrectionKind;
  /** The human's note, used as a rubric by judge-style scorers. */
  note?: string | null;
}

// ---------- helpers ----------

export function normalizeText(v: unknown, caseSensitive = false): string {
  const s = typeof v === "string" ? v : v === null || v === undefined ? "" : canonicalJSON(v);
  const t = s.trim().replace(/\s+/g, " ");
  return caseSensitive ? t : t.toLowerCase();
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

/** Subset match: every key in `expected` must be present and equal in `actual` (recursively). */
export function isSubset(expected: unknown, actual: unknown): { ok: boolean; path: string } {
  return subsetAt(expected, actual, "$");
}

function subsetAt(expected: unknown, actual: unknown, path: string): { ok: boolean; path: string } {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return { ok: false, path };
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      const r = subsetAt(v, (actual as Record<string, unknown>)[k], `${path}.${k}`);
      if (!r.ok) return r;
    }
    return { ok: true, path };
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return { ok: false, path };
    for (let i = 0; i < expected.length; i++) {
      const r = subsetAt(expected[i], actual[i], `${path}[${i}]`);
      if (!r.ok) return r;
    }
    return { ok: true, path };
  }
  if (typeof expected === "string" && typeof actual === "string") {
    return { ok: normalizeText(expected) === normalizeText(actual), path };
  }
  if (typeof expected === "number" && typeof actual === "string" && Number(actual) === expected)
    return { ok: true, path };
  return { ok: deepEqual(expected, actual), path };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function pick(value: unknown, paths: string[]): unknown[] {
  return paths.flatMap((p) => JSONPath({ path: p, json: value as object, wrap: true }) as unknown[]);
}

function stripPaths(value: unknown, paths: string[]): unknown {
  if (!paths.length) return value;
  const clone = JSON.parse(JSON.stringify(value ?? null)) as unknown;
  for (const p of paths) {
    JSONPath({
      path: p,
      json: clone as object,
      callback: (
        _v: unknown,
        _t: unknown,
        payload: { parent: Record<string, unknown> | unknown[]; parentProperty: string | number },
      ) => {
        if (Array.isArray(payload.parent)) payload.parent.splice(Number(payload.parentProperty), 1);
        else delete payload.parent[String(payload.parentProperty)];
      },
    });
  }
  return clone;
}

// ---------- scorers ----------

export async function scoreEquals(input: ScoreInput, ctx: ScorerContext): Promise<ScoreResult> {
  const caseSensitive = input.config.caseSensitive === true;
  const a = normalizeText(input.expected, caseSensitive);
  const b = normalizeText(input.actual, caseSensitive);
  if (a === b) return { score: 1, passed: true, reason: "exact match" };
  if (input.config.fallback === "semantic" && ctx.embed) {
    const r = await scoreSemantic(input, ctx);
    return { ...r, reason: `not equal; semantic ${r.reason}` };
  }
  return { score: 0, passed: false, reason: `expected ${truncate(a)} got ${truncate(b)}` };
}

export async function scoreJsonMatch(input: ScoreInput): Promise<ScoreResult> {
  const fields = Array.isArray(input.config.fields) ? (input.config.fields as string[]) : [];
  const ignore = Array.isArray(input.config.ignore) ? (input.config.ignore as string[]) : [];
  if (fields.length > 0) {
    const e = pick(input.expected, fields);
    const a = pick(input.actual, fields);
    const matches = e.filter((v, i) => deepEqual(v, a[i])).length;
    const score = e.length === 0 ? 1 : matches / e.length;
    return {
      score,
      passed: score === 1,
      reason: score === 1 ? `fields ${fields.join(", ")} match` : `${matches}/${e.length} fields match`,
    };
  }
  const expected = stripPaths(input.expected, ignore);
  const actual = stripPaths(input.actual, ignore);
  const r = isSubset(expected, actual);
  if (r.ok) return { score: 1, passed: true, reason: "expected fields match" };
  // partial credit: fraction of top-level expected keys that match
  if (
    expected &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    actual &&
    typeof actual === "object"
  ) {
    const keys = Object.keys(expected as object);
    const ok = keys.filter(
      (k) => subsetAt((expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], k).ok,
    ).length;
    return { score: keys.length ? ok / keys.length : 0, passed: false, reason: `mismatch at ${r.path}` };
  }
  return { score: 0, passed: false, reason: `mismatch at ${r.path}` };
}

export async function scoreToolChoice(input: ScoreInput): Promise<ScoreResult> {
  const exp = isToolDecision(input.expected) ? input.expected.tool_calls : null;
  const act = isToolDecision(input.actual) ? input.actual.tool_calls : null;
  if (!exp || exp.length === 0) return { score: 0, passed: false, reason: "expected has no tool decision" };
  if (!act || act.length === 0) return { score: 0, passed: false, reason: "no tool call in output" };
  const e = exp[0]!;
  const a = act[0]!;
  if (e.name !== a.name) return { score: 0, passed: false, reason: `expected tool ${e.name}, got ${a.name}` };
  const matchOn = Array.isArray(input.config.matchOn) ? (input.config.matchOn as string[]) : undefined;
  const ignoreArgs = Array.isArray(input.config.ignoreArgs)
    ? (input.config.ignoreArgs as string[])
    : undefined;
  const same =
    toolFingerprint(e.name, e.args, { matchOn, ignoreArgs }) ===
    toolFingerprint(a.name, a.args, { matchOn, ignoreArgs });
  return same
    ? { score: 1, passed: true, reason: `same tool and arguments (${e.name})` }
    : { score: 0.5, passed: false, reason: `same tool ${e.name} but different arguments` };
}

export async function scoreSemantic(input: ScoreInput, ctx: ScorerContext): Promise<ScoreResult> {
  if (!ctx.embed) return { score: 0, passed: false, reason: "semantic scorer needs an embedding model" };
  const threshold = typeof input.config.threshold === "number" ? input.config.threshold : 0.85;
  const [a, b] = await Promise.all([
    ctx.embed(normalizeText(input.expected, true)),
    ctx.embed(normalizeText(input.actual, true)),
  ]);
  const sim = cosine(a, b);
  return {
    score: Math.max(0, sim),
    passed: sim >= threshold,
    reason: `cosine ${sim.toFixed(3)} ${sim >= threshold ? "≥" : "<"} ${threshold}`,
  };
}

export function buildJudgePrompt(input: ScoreInput): string {
  const rubric = [
    input.note,
    typeof (input.expected as { rubric?: unknown })?.rubric === "string"
      ? (input.expected as { rubric: string }).rubric
      : null,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
  const expected = isRubricWrapper(input.expected) ? input.expected.not_equals : input.expected;
  const lines = [
    "You are grading an AI agent's output against a human reviewer's correction.",
    'Answer with JSON: {"pass": boolean, "reason": string}. Be strict: pass only if the output satisfies the reviewer.',
    "",
  ];
  if (input.kind === "reject")
    lines.push(
      "The reviewer REJECTED the original output below. The new output passes only if it avoids the same mistake.",
      "",
      `Rejected output:\n${pretty(expected)}`,
    );
  else if (input.kind === "escalate")
    lines.push(
      "The reviewer said a human should have handled this. The new output passes only if it escalates or hands off to a human instead of acting on its own.",
    );
  else lines.push(`Expected output (from the reviewer):\n${pretty(expected)}`);
  if (rubric) lines.push("", `Reviewer's note (rubric):\n${rubric}`);
  lines.push("", `Output under test:\n${pretty(input.actual)}`);
  return lines.join("\n");
}

function isRubricWrapper(v: unknown): v is { not_equals: unknown; rubric: string | null } {
  return typeof v === "object" && v !== null && "not_equals" in v;
}

export async function scoreJudge(input: ScoreInput, ctx: ScorerContext): Promise<ScoreResult> {
  if (!ctx.judge) return { score: 0, passed: false, reason: "judge scorer needs a judge model" };
  const verdict = await ctx.judge(buildJudgePrompt(input));
  return { score: verdict.pass ? 1 : 0, passed: verdict.pass, reason: `judge: ${verdict.reason}` };
}

export async function scoreNotEquals(input: ScoreInput, ctx: ScorerContext): Promise<ScoreResult> {
  const original = isRubricWrapper(input.expected) ? input.expected.not_equals : input.expected;
  if (deepEqual(original, input.actual) || normalizeText(original) === normalizeText(input.actual)) {
    return { score: 0, passed: false, reason: "output equals the rejected output" };
  }
  const rubric = isRubricWrapper(input.expected) ? input.expected.rubric : input.note;
  if (input.config.judge && rubric && ctx.judge) {
    const r = await scoreJudge({ ...input, note: rubric }, ctx);
    return { ...r, reason: `differs from the rejected output; ${r.reason}` };
  }
  return { score: 1, passed: true, reason: "differs from the rejected output" };
}

const ESCALATE_RE = /escalat|hand(?:ed)?[ -]?off|human|supervisor|transfer to (?:a )?(?:person|agent)/i;

export function looksLikeEscalation(actual: unknown): boolean {
  if (isToolDecision(actual)) return actual.tool_calls.some((t) => ESCALATE_RE.test(t.name));
  if (actual && typeof actual === "object") {
    const o = actual as Record<string, unknown>;
    if (o.escalate === true || o.escalated === true || o.needs_human === true || o.should_escalate === true)
      return true;
    if (typeof o.action === "string" && ESCALATE_RE.test(o.action)) return true;
    return Object.values(o).some((v) => typeof v === "string" && ESCALATE_RE.test(v));
  }
  return typeof actual === "string" && ESCALATE_RE.test(actual);
}

export async function scoreShouldEscalate(input: ScoreInput, ctx: ScorerContext): Promise<ScoreResult> {
  const escalated = looksLikeEscalation(input.actual);
  const rubric =
    typeof (input.expected as { rubric?: unknown })?.rubric === "string"
      ? (input.expected as { rubric: string }).rubric
      : input.note;
  if (input.config.judge && rubric && ctx.judge) {
    const r = await scoreJudge({ ...input, note: rubric }, ctx);
    return { ...r, reason: `${escalated ? "escalation detected" : "no escalation detected"}; ${r.reason}` };
  }
  return escalated
    ? { score: 1, passed: true, reason: "output escalates to a human" }
    : { score: 0, passed: false, reason: "output does not escalate" };
}

export async function score(input: ScoreInput, ctx: ScorerContext = {}): Promise<ScoreResult> {
  switch (input.scorer) {
    case "equals":
      return scoreEquals(input, ctx);
    case "json_match":
      return scoreJsonMatch(input);
    case "tool_choice":
      return scoreToolChoice(input);
    case "semantic":
      return scoreSemantic(input, ctx);
    case "judge":
      return scoreJudge(input, ctx);
    case "not_equals":
      return scoreNotEquals(input, ctx);
    case "should_escalate":
      return scoreShouldEscalate(input, ctx);
  }
}

function pretty(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
