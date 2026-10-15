/**
 * Applies 20 realistic human corrections to the seeded runs:
 *   8 priority edits for enterprise customers (the v1 prompt lacks the enterprise bump),
 *   2 rejects (wrong team), 10 approves.
 *
 *   OVERTURN_API_KEY=ov_live_... pnpm --filter @overturn-ai/example-ticket-triage corrections
 */
import { Overturn } from "@overturn-ai/sdk";
import type { CorrectionResult, Run } from "@overturn-ai/shared";
import { customers, type Priority, tickets } from "./data.js";

const bump = (p: string): Priority => (p === "P0" ? "P0" : (`P${Number(p[1]) - 1}` as Priority));

export interface PlannedCorrection {
  ticketId: string;
  kind: "edit" | "reject" | "approve";
  correctedOutput?: { priority: Priority };
  note?: string;
  actor: string;
}

/** The plan is derived from the data so it stays honest if the tickets change. */
export function planCorrections(): PlannedCorrection[] {
  const enterprise = new Set(customers.filter((c) => c.plan === "enterprise").map((c) => c.email));
  const isEnterprise = (id: string) => enterprise.has(tickets.find((t) => t.id === id)!.customerEmail);

  // 8 enterprise tickets whose baseline priority is not already P0 (the fake v1 model's decisions are
  // deterministic; with a real model the edit still encodes the same rule).
  const editIds = ["T-1003", "T-1004", "T-1013", "T-1014", "T-1015", "T-1016", "T-1025", "T-1026"];
  for (const id of editIds) if (!isEnterprise(id)) throw new Error(`${id} is not an enterprise ticket`);

  const rejects: PlannedCorrection[] = [
    {
      ticketId: "T-1030",
      kind: "reject",
      note: "Status-page complaints go to the incident commander, not infrastructure",
      actor: "priya@support.example",
    },
    {
      ticketId: "T-1019",
      kind: "reject",
      note: "Docs bugs are a product-docs issue, not support",
      actor: "priya@support.example",
    },
  ];
  const approves: PlannedCorrection[] = [
    "T-1001",
    "T-1002",
    "T-1005",
    "T-1007",
    "T-1008",
    "T-1009",
    "T-1010",
    "T-1011",
    "T-1020",
    "T-1022",
  ].map((ticketId) => ({ ticketId, kind: "approve", actor: "sam@support.example" }));
  const edits: PlannedCorrection[] = editIds.map((ticketId) => ({
    ticketId,
    kind: "edit",
    note: "Enterprise customer: contractual priority bump",
    actor: "rayfan-reviewer@support.example",
  }));
  return [...edits, ...rejects, ...approves];
}

const SCORED_FIELDS = ["priority", "team"];

export async function applyCorrections(ov: Overturn): Promise<CorrectionResult[]> {
  const page = await ov.api.runs.list({ agent: "ticket-triage", limit: 200 });
  const byTicket = new Map<string, Run>();
  // newest first: keep the latest run per ticket
  for (const r of page.items) if (r.externalId && !byTicket.has(r.externalId)) byTicket.set(r.externalId, r);

  const results: CorrectionResult[] = [];
  for (const plan of planCorrections()) {
    const run = byTicket.get(plan.ticketId);
    if (!run) throw new Error(`No recorded run for ${plan.ticketId}; run the seed first`);
    const output = run.output as { priority: string } | null;
    const correctedOutput = plan.kind === "edit" ? { priority: bump(output?.priority ?? "P3") } : undefined;
    const result = await ov.correct({
      runId: run.id,
      kind: plan.kind,
      correctedOutput,
      note: plan.note,
      actor: plan.actor,
    });
    // The decision under test is the routing, not the wording of the reply: score on
    // priority + team so a different model's phrasing is not a regression.
    if (result.case) {
      await ov.api.cases.patch(result.case.id, {
        scorer: "json_match",
        scorerConfig: { fields: SCORED_FIELDS },
      });
    }
    results.push(result);
  }
  return results;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  for (const f of [".env", "../../.env"]) {
    try {
      process.loadEnvFile(f);
      break;
    } catch {}
  }
  const ov = new Overturn();
  applyCorrections(ov)
    .then((rs) => {
      const kinds = rs.reduce<Record<string, number>>((acc, r) => {
        acc[r.correction.kind] = (acc[r.correction.kind] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `applied ${rs.length} corrections (${JSON.stringify(kinds)}), ${rs.filter((r) => r.case).length} cases created`,
      );
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
