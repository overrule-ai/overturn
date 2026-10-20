import { type CorrectionKind, correctionKindSchema, jsonValueSchema } from "@overturn-ai/shared";
import { z } from "zod";
import type { Overturn } from "./client.js";

/** What `<CorrectButton>` posts. The project API key never reaches the browser. */
export const correctionRequestSchema = z.object({
  runId: z.string().uuid(),
  stepId: z.string().uuid().nullish(),
  kind: correctionKindSchema,
  correctedOutput: jsonValueSchema.optional(),
  note: z.string().max(10_000).nullish(),
});
export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;

export interface CorrectionHandlerOptions {
  /**
   * Who is correcting, from your session (an email, a user id). Return null to record
   * the correction anonymously, or throw / return a Response to refuse it.
   */
  actor?: (request: Request) => Promise<string | null | Response> | string | null | Response;
}

/**
 * A fetch-style handler (`(Request) => Promise<Response>`) that turns a browser
 * correction into `ov.correct()`. Mount it on one route of your app and point
 * `<CorrectButton endpoint>` at it. Works as a Next.js route handler, in Hono,
 * Remix, Bun, Deno and anything else that speaks `Request`/`Response`.
 *
 * ```ts
 * // app/api/overturn/correct/route.ts
 * export const POST = ov.correctionHandler({ actor: async (req) => (await auth(req))?.email ?? null });
 * ```
 */
export function createCorrectionHandler(
  ov: Pick<Overturn, "correct">,
  options: CorrectionHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = correctionRequestSchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid correction", details: parsed.error.issues }, 400);
    let actor: string | null = null;
    if (options.actor) {
      const a = await options.actor(request);
      if (a instanceof Response) return a;
      actor = a;
    }
    const input: Parameters<Overturn["correct"]>[0] = {
      runId: parsed.data.runId,
      stepId: parsed.data.stepId ?? null,
      kind: parsed.data.kind as CorrectionKind,
      correctedOutput: parsed.data.correctedOutput,
      note: parsed.data.note ?? null,
      actor,
    };
    try {
      const result = await ov.correct(input);
      return json(result, 200);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
