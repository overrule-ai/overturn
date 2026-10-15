import type { Overturn } from "@overturn/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { type Decision, PRIORITIES, TEAMS, type Ticket } from "./data.js";
import { PROMPT_VERSION, systemPrompt } from "./prompts.js";
import { makeTools } from "./tools.js";

export const decisionSchema = z.object({
  priority: z.enum(PRIORITIES),
  team: z.enum(TEAMS),
  reply: z.string().min(1),
});

export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    priority: { type: "string", enum: [...PRIORITIES] },
    team: { type: "string", enum: [...TEAMS] },
    reply: { type: "string" },
  },
  required: ["priority", "team", "reply"],
  additionalProperties: false,
} as const;

export interface AgentOptions {
  ov: Overturn;
  openai: OpenAI;
  model: string;
  promptVersion?: string;
}

/**
 * Creates an OpenAI client. With OPENAI_API_KEY unset it points at the local
 * fake server (see fake-openai.ts) so the example runs without a key.
 */
export function makeOpenAI(ov: Overturn): { openai: OpenAI; model: string; fake: boolean } {
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    return {
      openai: ov.wrapOpenAI(new OpenAI({ apiKey: key })),
      model: process.env.TRIAGE_MODEL ?? "gpt-4.1-mini",
      fake: false,
    };
  }
  const baseURL = process.env.FAKE_OPENAI_URL ?? "http://127.0.0.1:4010/v1";
  return {
    openai: ov.wrapOpenAI(new OpenAI({ apiKey: "fake", baseURL })),
    model: process.env.TRIAGE_MODEL ?? "fake-triage-v1",
    fake: true,
  };
}

export function makeAgent({ ov, openai, model, promptVersion = PROMPT_VERSION }: AgentOptions) {
  const tools = makeTools(ov);

  /** One trajectory: two read-only tools, one model call, two side-effect tools. */
  return async function triage(ticket: Ticket): Promise<Decision> {
    const customer = await tools.lookupCustomer({ email: ticket.customerEmail });
    const articles = await tools.searchKb({ query: `${ticket.subject} ${ticket.body}` });

    const completion = await openai.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt(promptVersion) },
        {
          role: "user",
          content: JSON.stringify({ ticket, customer, articles }, null, 2),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "triage_decision", strict: true, schema: DECISION_JSON_SCHEMA },
      },
    });

    const raw = completion.choices[0]?.message.content ?? "{}";
    const decision = decisionSchema.parse(JSON.parse(raw));

    await tools.setPriority({ ticketId: ticket.id, priority: decision.priority });
    await tools.assignTeam({ ticketId: ticket.id, team: decision.team });
    return decision;
  };
}
