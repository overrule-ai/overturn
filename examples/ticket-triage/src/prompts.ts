/**
 * Prompt variants. v1 is the baseline the runs are recorded with. The
 * corrections in corrections.ts encode the rule v1 is missing (enterprise
 * customers get bumped one level), so v2 should fix those cases, and the
 * `weak` variant drops the urgency rule so approve cases regress.
 */

export const PROMPT_VERSION = process.env.TRIAGE_PROMPT_VERSION ?? "v1";

const base = `You are a support triage agent. Given a ticket, the customer record and relevant knowledge-base articles, decide:
- priority: P0 (platform outage or all users of a company locked out), P1 (production impact for a company, security, or data-loss risk), P2 (a feature is broken for one user, billing errors, API/integration bugs), P3 (questions, feature requests, how-to)
- team: one of infrastructure, identity, billing, integrations, mobile, trust, support. Use the KB article owner when it names one; otherwise support.
- reply: a short, specific first response to the customer (2-3 sentences).
Return only JSON with keys priority, team, reply.`;

const enterpriseRule = `
Enterprise customers are contractually prioritized: raise the priority one level (P3->P2, P2->P1, P1->P0) for any customer whose plan is "enterprise".`;

const urgencyRule = `
Outage keywords ("down", "outage", "502", "cannot log in", "locked out", "crash") indicate production impact: never classify them below P1.`;

export const PROMPTS: Record<string, string> = {
  v1: base, // oops: the urgency rule was dropped
  v2: base + urgencyRule + enterpriseRule,
  weak: base,
};

export function systemPrompt(version: string = PROMPT_VERSION): string {
  const p = PROMPTS[version];
  if (!p) throw new Error(`Unknown prompt version ${version}; known: ${Object.keys(PROMPTS).join(", ")}`);
  return p;
}
