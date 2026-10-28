import type { CaptureAnswer, CaptureMessage } from "./schemas.js";

/** Whitespace-insensitive comparison: a re-wrapped paragraph is the same answer. */
export function normalizeCaptureText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/**
 * The answer a capture freezes: the text alone when there are no fields, else the fields
 * with the text under `reply`. That shape is what the auto scorer expects: short fields are
 * scored exactly, the prose is left to the judge.
 */
export function captureAnswerValue(a: CaptureAnswer): unknown {
  const text = a.text.trim();
  const fields = a.fields ?? {};
  if (Object.keys(fields).length === 0) return text;
  return { ...fields, reply: text };
}

export interface CaptureDiff {
  changed: boolean;
  textChanged: boolean;
  changedFields: string[];
}

/** What the expert changed between the draft and what they sent. */
export function diffCaptureAnswers(draft: CaptureAnswer, sent: CaptureAnswer): CaptureDiff {
  const textChanged = normalizeCaptureText(draft.text) !== normalizeCaptureText(sent.text);
  const keys = new Set([...Object.keys(draft.fields ?? {}), ...Object.keys(sent.fields ?? {})]);
  const changedFields = [...keys]
    .filter((k) => stableJson(draft.fields?.[k] ?? null) !== stableJson(sent.fields?.[k] ?? null))
    .sort();
  return { changed: textChanged || changedFields.length > 0, textChanged, changedFields };
}

const ROLE_LABEL: Record<CaptureMessage["role"], string> = {
  customer: "Customer",
  agent: "Agent",
  note: "Internal note",
  system: "System",
};

/** The thread rendered as the user turn of the frozen prompt, oldest first. */
export function renderCaptureContext(
  context: CaptureMessage[],
  opts: { subject?: string | null; fields?: Record<string, unknown> } = {},
): string {
  const parts: string[] = [];
  if (opts.subject) parts.push(`Subject: ${opts.subject}`);
  const fieldKeys = Object.keys(opts.fields ?? {});
  if (fieldKeys.length > 0) {
    parts.push(`Fields to decide: ${fieldKeys.join(", ")}\nCurrent values: ${JSON.stringify(opts.fields)}`);
  }
  for (const m of context) {
    const who = m.author ? `${ROLE_LABEL[m.role]} (${m.author})` : ROLE_LABEL[m.role];
    const when = m.at ? ` · ${m.at}` : "";
    parts.push(`${who}${when}:\n${m.content.trim()}`);
  }
  return parts.join("\n\n");
}

/** The system turn of the frozen prompt: what the drafting model was asked to do. */
export function captureSystemPrompt(agent: string, source: string): string {
  return `You are drafting the next reply for the "${agent}" workflow in ${source}. Answer the thread below as the expert on this team would: accurate, complete, and in the team's voice. When decision fields are listed, return the reply text and the decided values.`;
}
