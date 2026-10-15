import type { Overturn } from "@overturn-ai/sdk";
import { type Customer, customers, type KbArticle, kb, type Priority, type Team } from "./data.js";

/** In-memory "ticket system" so the side-effect tools do something observable. */
export const ticketState = new Map<string, { priority?: Priority; team?: Team }>();

export function makeTools(ov: Overturn) {
  const lookupCustomer = ov.tool(
    "lookup_customer",
    async ({ email }: { email: string }): Promise<Customer | null> => {
      return customers.find((c) => c.email.toLowerCase() === email.toLowerCase()) ?? null;
    },
    { sideEffect: false, matchOn: ["email"], description: "Look up a customer record by email" },
  );

  const searchKb = ov.tool(
    "search_kb",
    async ({ query }: { query: string }): Promise<Array<Pick<KbArticle, "id" | "title" | "body">>> => {
      const words = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2);
      const scored = kb
        .map((a) => {
          const hay = `${a.title} ${a.body} ${a.tags.join(" ")}`.toLowerCase();
          const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
          return { a, score };
        })
        .filter((s) => s.score > 0)
        .sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id))
        .slice(0, 3);
      return scored.map(({ a }) => ({ id: a.id, title: a.title, body: a.body }));
    },
    { sideEffect: false, description: "Search the knowledge base" },
  );

  const setPriority = ov.tool(
    "set_priority",
    async ({ ticketId, priority }: { ticketId: string; priority: Priority }) => {
      const cur = ticketState.get(ticketId) ?? {};
      ticketState.set(ticketId, { ...cur, priority });
      return { ok: true, ticketId, priority };
    },
    { sideEffect: true, matchOn: ["ticketId", "priority"], description: "Set the ticket priority (P0..P3)" },
  );

  const assignTeam = ov.tool(
    "assign_team",
    async ({ ticketId, team }: { ticketId: string; team: Team }) => {
      const cur = ticketState.get(ticketId) ?? {};
      ticketState.set(ticketId, { ...cur, team });
      return { ok: true, ticketId, team };
    },
    { sideEffect: true, matchOn: ["ticketId", "team"], description: "Route the ticket to a team" },
  );

  return { lookupCustomer, searchKb, setPriority, assignTeam };
}
