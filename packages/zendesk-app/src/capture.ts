import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import { diffCaptureAnswers, normalizeCaptureText } from "@overturn-ai/shared/capture";

/** What the app knows about the ticket, read through ZAF. */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  /** Oldest first, as ZAF returns `ticket.comments`. */
  comments: Array<{
    id?: number | string;
    value: string;
    type: "publicReply" | "internalNote" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    isAgent?: boolean;
    createdAt?: string | null;
  }>;
  /** Custom fields the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Block the send until the agent types a reason when the reply was changed. */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** `custom_field_123:status, custom_field_9:reserve` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "claims-reply",
  requireReason: false,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
};

/** Parses the app's metadata settings (strings and booleans from the manifest). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
  };
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a macro,
 * a paste), not typed, and it is the draft. The agent can also mark the current text as the
 * draft by hand, and a drafting agent that recorded its run with the SDK is found by ticket id.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function role(c: TicketSnapshot["comments"][number]): CaptureMessage["role"] {
  if (c.type === "internalNote") return "note";
  return c.isAgent ? "agent" : "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(ticket: TicketSnapshot): CaptureMessage[] {
  return ticket.comments
    .filter((c) => c.value?.trim())
    .map((c) => ({
      role: role(c),
      author: c.authorEmail ?? c.authorName ?? null,
      content: stripHtml(c.value),
      at: c.createdAt ?? null,
    }));
}

/** ZAF hands comment bodies back as HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the agent hits Submit. Pure: the ZAF glue only forwards the answer. */
export function decideOnSend(input: {
  ticket: TicketSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  reason: string;
  actor: string | null;
  settings: AppSettings;
}): SendDecision {
  const { ticket, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  if (diff.changed && settings.requireReason && !reason) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "zendesk",
    externalId: `zd:${ticket.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: ticket.subject,
    context: contextFrom(ticket),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: ticket.url,
    tags: [`draft:${draft.origin}`, send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata: { requester: ticket.requesterEmail ?? ticket.requesterName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the sidebar. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

export const QUICK_REASONS = [
  "Wrong coverage decision",
  "Wrong amount or date",
  "Missing required step",
  "Tone / wording",
  "Policy exception",
];
