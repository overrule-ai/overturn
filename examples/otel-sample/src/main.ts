/**
 *   OVERTURN_API_KEY=ov_live_... OVERTURN_BASE_URL=http://localhost:4000 pnpm --filter @overturn-ai/example-otel-sample start
 */
import { makeOtelAgent } from "./agent.js";
import { startTracing } from "./tracing.js";

for (const f of [".env", "../../.env"]) {
  try {
    process.loadEnvFile(f);
    break;
  } catch {}
}

const provider = startTracing({
  baseUrl: process.env.OVERTURN_BASE_URL ?? "http://localhost:4000",
  apiKey: process.env.OVERTURN_API_KEY ?? "",
});
const triage = makeOtelAgent();

const tickets = [
  { id: "O-1", subject: "Site is down", body: "502 everywhere", customerEmail: "rayfan@acme.com" },
  {
    id: "O-2",
    subject: "Question about pricing",
    body: "Is there a student plan?",
    customerEmail: "tom@gmail.com",
  },
  { id: "O-3", subject: "Outage in EU region", body: "Nothing loads", customerEmail: "dev@sideproject.app" },
];
for (const t of tickets) console.log(t.id, await triage(t));
await provider.shutdown();
console.log("exported 3 traces");
