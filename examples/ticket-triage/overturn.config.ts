import { Overturn } from "@overturn/sdk";
import OpenAI from "openai";
import { defineConfig } from "overturn";
import { makeAgent } from "./src/agent.js";
import type { Ticket } from "./src/data.js";

/**
 * Trajectory replay entry point. `overturn replay --mode trajectory` calls `agent`
 * with each case's recorded ticket while the SDK is in replay mode: lookup_customer
 * and search_kb answer from the recording, set_priority / assign_team are refused
 * (side effects never run), and the model call goes to the target model.
 */
export default defineConfig({
  agent: async (input, ctx) => {
    const ov = new Overturn({ enabled: false });
    // The client is never used for real in replay; the SDK answers from the target model.
    const openai = ov.wrapOpenAI(
      new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "replay", baseURL: process.env.FAKE_OPENAI_URL }),
    );
    const triage = makeAgent({
      ov,
      openai,
      model: ctx.model,
      promptVersion: ctx.promptVersion?.split("@")[1],
    });
    return triage(input as Ticket);
  },
  maxSteps: 20,
});
