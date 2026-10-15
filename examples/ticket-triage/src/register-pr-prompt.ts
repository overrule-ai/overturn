/**
 * Registers this checkout's v1 prompt as `ticket-triage@pr`, so a replay can target the
 * prompt in a pull request against cases recorded with the production prompt.
 */
import { Overturn } from "@overturn/sdk";
import { PROMPTS } from "./prompts.js";

for (const f of [".env", "../../.env"]) {
  try {
    process.loadEnvFile(f);
    break;
  } catch {}
}
const ov = new Overturn();
const pv = await ov.api.prompts.register({ name: "ticket-triage", version: "pr", template: PROMPTS.v1! });
console.log(`registered ticket-triage@pr (${pv.hash.slice(0, 12)})`);
