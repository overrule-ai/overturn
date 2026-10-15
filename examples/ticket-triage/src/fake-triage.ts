/**
 * A deterministic, rule-based stand-in for the triage model. It exists so the
 * example, the tests and a keyless quickstart are reproducible. It is NOT an
 * LLM: it reads the rules in the system prompt (urgency, enterprise) and the
 * ticket text, and returns the same JSON shape a real model would.
 *
 * Model ids:
 *   fake-triage-v1    follows whatever rules the prompt contains
 *   fake-triage-weak  ignores the urgency rule (demotes outages), so approve cases regress
 */
import type { Decision, Priority, Team } from "./data.js";

const KB_OWNER: Record<string, Team> = {
  "KB-101": "infrastructure",
  "KB-102": "identity",
  "KB-103": "billing",
  "KB-104": "support",
  "KB-105": "support",
  "KB-106": "trust",
  "KB-107": "mobile",
  "KB-108": "support",
  "KB-109": "integrations",
};

interface Input {
  ticket: { id: string; subject: string; body: string; customerEmail: string };
  customer: { plan?: string; name?: string } | null;
  articles: Array<{ id: string; title: string }>;
}

const bump = (p: Priority): Priority => (p === "P0" ? "P0" : (`P${Number(p[1]) - 1}` as Priority));
const demote = (p: Priority): Priority => (p === "P3" ? "P3" : (`P${Number(p[1]) + 1}` as Priority));

function has(text: string, ...words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

export function fakeTriage(systemPrompt: string, userContent: string, model: string): Decision {
  const input = JSON.parse(userContent) as Input;
  const text = `${input.ticket.subject} ${input.ticket.body}`.toLowerCase();
  const urgencyRule = /outage keywords/i.test(systemPrompt) && model !== "fake-triage-weak";
  const enterpriseRule = /enterprise customers are contractually prioritized/i.test(systemPrompt);

  let priority: Priority;
  const outageWide = has(
    text,
    "entire workspace",
    "none of our",
    "nobody in the company",
    "complete outage",
    "every login",
  );
  const outage = has(
    text,
    "down",
    "outage",
    "502",
    "locked out",
    "cannot log in",
    "can't log in",
    "crash",
    "production jobs are failing",
  );
  if (outageWide) priority = "P0";
  else if (outage) priority = "P1";
  else if (
    has(
      text,
      "refund",
      "charged",
      "charge",
      "invoice",
      "duplicate",
      "not syncing",
      "stale",
      "fails",
      "wrong",
      "garbled",
      "time out",
      "times out",
      "stopped",
      "spins forever",
      "error",
      "throttled",
      "does not match",
    )
  )
    priority = "P2";
  else priority = "P3";

  if (!urgencyRule && (priority === "P0" || priority === "P1")) priority = demote(priority);
  if (enterpriseRule && input.customer?.plan === "enterprise") priority = bump(priority);

  let team: Team = "support";
  const top = input.articles[0];
  if (top && KB_OWNER[top.id]) team = KB_OWNER[top.id]!;
  if (has(text, "soc 2", "security", "gdpr", "delete my", "data residency")) team = "trust";
  if (has(text, "sso", "saml", "password", "reset email")) team = "identity";
  if (has(text, "refund", "invoice", "charged", "po number", "discount", "seat")) team = "billing";
  if (has(text, "webhook", "slack", "jira", "integration")) team = "integrations";
  if (has(text, "ios", "android", "mobile", "phones")) team = "mobile";
  if (outageWide || has(text, "502", "status page")) team = "infrastructure";
  if (has(text, "feature request", "idea:", "would love", "nice to have", "how do i")) team = "support";

  const name = input.customer?.name?.split(" ")[0] ?? "there";
  const reply =
    priority === "P0"
      ? `Hi ${name}, we're treating this as a critical incident and our ${team} team is on it now. We'll post updates on the status page every 15 minutes until it's resolved.`
      : priority === "P1"
        ? `Hi ${name}, thanks for flagging this. We've escalated it to the ${team} team as a high-priority issue and will update you within the hour.`
        : priority === "P2"
          ? `Hi ${name}, sorry about that. We've routed this to our ${team} team and will follow up within one business day.`
          : `Hi ${name}, thanks for reaching out. Our ${team} team will get back to you within two business days.`;

  return { priority, team, reply };
}
