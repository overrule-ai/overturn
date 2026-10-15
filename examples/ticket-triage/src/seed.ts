/**
 * Runs the triage agent over the 30 synthetic tickets and records every run.
 *
 *   OVERTURN_API_KEY=ov_live_... pnpm --filter @overturn/example-ticket-triage seed
 *
 * Without OPENAI_API_KEY it starts the fake model server itself.
 */
import { Overturn } from "@overturn/sdk";
import { makeAgent, makeOpenAI } from "./agent.js";
import { tickets } from "./data.js";
import { startFakeOpenAI } from "./fake-openai.js";
import { PROMPT_VERSION, PROMPTS } from "./prompts.js";

/** Registers every prompt variant so `overturn replay --prompt ticket-triage@v2` can target it. */
export async function registerPrompts(ov: Overturn): Promise<void> {
  if (!ov.apiKey) return;
  for (const [version, template] of Object.entries(PROMPTS)) {
    await ov.api.prompts.register({ name: "ticket-triage", version, template });
  }
}

export interface SeedResult {
  runIds: string[];
  model: string;
  fake: boolean;
}

export async function seed(
  ov: Overturn,
  opts: { limit?: number; tags?: string[] } = {},
): Promise<SeedResult> {
  let stop: (() => void) | null = null;
  if (!process.env.OPENAI_API_KEY && !process.env.FAKE_OPENAI_URL) {
    const { server, url } = await startFakeOpenAI(0);
    process.env.FAKE_OPENAI_URL = url;
    stop = () => server.close();
  }
  const { openai, model, fake } = makeOpenAI(ov);
  const triage = makeAgent({ ov, openai, model });
  const runIds: string[] = [];
  try {
    await registerPrompts(ov);
    for (const ticket of tickets.slice(0, opts.limit ?? tickets.length)) {
      const run = ov.startRun({
        agent: "ticket-triage",
        version: `1.0.0+${PROMPT_VERSION}`,
        input: ticket,
        externalId: ticket.id,
        tags: opts.tags ?? ["prod", "seed"],
        metadata: { model, promptVersion: PROMPT_VERSION },
      });
      await run.context(async () => {
        try {
          const decision = await triage(ticket);
          run.end({ output: decision });
        } catch (err) {
          run.end({ error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      });
      runIds.push(run.id);
    }
  } finally {
    await ov.flush();
    stop?.();
  }
  return { runIds, model, fake };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  for (const f of [".env", "../../.env"]) {
    try {
      process.loadEnvFile(f);
      break;
    } catch {}
  }
  const ov = new Overturn({ debug: true });
  seed(ov)
    .then(async (r) => {
      await ov.shutdown();
      console.log(
        `recorded ${r.runIds.length} runs with model ${r.model}${r.fake ? " (fake, no OPENAI_API_KEY set)" : ""}`,
      );
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
