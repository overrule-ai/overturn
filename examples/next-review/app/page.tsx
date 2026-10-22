import { ov } from "@/lib/overturn";
import { Review } from "./review";

export const dynamic = "force-dynamic";

// A server component: lists the agent's latest runs with the SDK's REST client and
// puts a CorrectButton next to each answer. Corrections become Overturn cases.
export default async function Page() {
  const page = await ov.api.runs.list({ limit: 20 });
  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: 32 }}>
      <h1 style={{ fontSize: 22, fontWeight: 500 }}>Agent answers to review</h1>
      <p style={{ color: "#8b8b95" }}>
        Approve what is right, edit what is wrong. Every correction becomes a regression case in Overturn.
      </p>
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
        {page.items.map((run) => (
          <li
            key={run.id}
            data-testid="run"
            style={{ border: "1px solid #26262c", borderRadius: 6, padding: 16, display: "grid", gap: 10 }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
              <strong>{run.agent}</strong>
              <code style={{ fontSize: 12, color: "#8b8b95" }}>{run.externalId ?? run.id.slice(-8)}</code>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "#8b8b95" }}>
                {run.correctionCount} correction{run.correctionCount === 1 ? "" : "s"}
              </span>
            </div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, color: "#c9c9cf" }}>
              {JSON.stringify(run.output, null, 2)}
            </pre>
            <Review runId={run.id} output={run.output} />
          </li>
        ))}
        {page.items.length === 0 && (
          <li style={{ color: "#8b8b95" }}>No runs yet. Record one with the SDK.</li>
        )}
      </ul>
    </main>
  );
}
