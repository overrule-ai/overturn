"use client";

import { narrative, type ReportRow } from "@overturn-ai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { KindBadge, StatusBadge, VerdictBadge } from "@/components/badges";
import { JsonView } from "@/components/json-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { client } from "@/lib/api";
import { money, pct } from "@/lib/utils";

/** Suppress a case from the suite straight from the report; the case stays and can be restored. */
function SuppressButton({ caseId, jobId }: { caseId: string; jobId: string }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => client.cases.patch(caseId, { status: "suppressed" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report", jobId] });
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
  });
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs text-muted-foreground"
      title="Take this case out of the default suite. Restore it from the cases list."
      onClick={() => m.mutate()}
      disabled={m.isPending || m.isSuccess}
      data-testid="suppress-case"
    >
      {m.isSuccess ? "Suppressed" : "Suppress"}
    </Button>
  );
}

/**
 * A new path: the agent called a tool with no recording. The reviewer sees the new call beside
 * the recorded call(s) of the same tool and, in one click, accepts it as equivalent — which
 * records the fingerprint on the case and lets this result stand as a pass.
 */
function NewPathRow({ r, jobId }: { r: ReportRow; jobId: string }) {
  const qc = useQueryClient();
  const np = r.newPath;
  const [pick, setPick] = useState(np?.candidates[0]?.fingerprint ?? "");
  const [note, setNote] = useState("");
  const accept = useMutation({
    mutationFn: () =>
      client.cases.acceptEquivalent(r.caseId, {
        toolName: np?.toolName ?? "",
        args: np?.args ?? null,
        equivalentOf: pick,
        note: note || null,
        jobId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report", jobId] });
      qc.invalidateQueries({ queryKey: ["case", r.caseId] });
    },
  });
  if (!np) return null;
  const chosen = np.candidates.find((c) => c.fingerprint === pick);
  return (
    <div className="rounded-lg border p-3" data-testid="new-path">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <VerdictBadge verdict={r.verdict} />
        <KindBadge kind={r.kind} />
        <Link className="font-medium underline-offset-2 hover:underline" href={`/cases/${r.caseId}`}>
          {r.title}
        </Link>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <code>{np.toolName}</code>
          <SuppressButton caseId={r.caseId} jobId={jobId} />
        </span>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{r.reason}</p>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">New call (no recording)</div>
          <JsonView value={np.args} collapsedAt={600} />
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Recorded call
            {np.candidates.length > 1 && (
              <select
                className="h-6 rounded border bg-background px-1 text-xs"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                {np.candidates.map((c, i) => (
                  <option key={c.fingerprint} value={c.fingerprint}>
                    recording {i + 1}
                  </option>
                ))}
              </select>
            )}
          </div>
          {chosen ? (
            <JsonView value={chosen.args} collapsedAt={600} />
          ) : (
            <p className="text-xs text-muted-foreground">
              This tool was never called in the recording, so there is nothing to answer it from. Correct the
              run with the new tool, or add the tool to the agent's recording.
            </p>
          )}
        </div>
      </div>
      {chosen && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="flex h-8 min-w-[240px] flex-1 rounded-md border px-2 text-xs"
            placeholder="Note (optional): same lookup, just the v2 endpoint"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="accept-note"
          />
          <Button
            size="sm"
            onClick={() => accept.mutate()}
            disabled={accept.isPending}
            data-testid="accept-path"
          >
            {accept.isPending ? "Accepting…" : "Accept as equivalent"}
          </Button>
        </div>
      )}
      {accept.error && <p className="mt-2 text-xs text-destructive">{accept.error.message}</p>}
    </div>
  );
}

function Section({
  title,
  rows,
  tone,
  jobId,
}: {
  title: string;
  rows: ReportRow[];
  tone: "danger" | "warning" | "success" | "muted";
  jobId: string;
}) {
  const color =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "success"
          ? "text-success"
          : "text-muted-foreground";
  return (
    <section className="space-y-2">
      <h2 className={`text-base font-semibold ${color}`}>
        {title} <span className="font-normal text-muted-foreground">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        rows.map((r) => (
          <div key={r.caseId} className="rounded-lg border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <VerdictBadge verdict={r.verdict} />
              <KindBadge kind={r.kind} />
              <Link className="font-medium underline-offset-2 hover:underline" href={`/cases/${r.caseId}`}>
                {r.title}
              </Link>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {r.scorer}
                  {r.score != null && ` · ${r.score.toFixed(2)}`}
                  {r.latencyMs != null && ` · ${Math.round(r.latencyMs)} ms`}
                  {r.costUsd != null && ` · ${money(r.costUsd)}`}
                </span>
                <SuppressButton caseId={r.caseId} jobId={jobId} />
              </span>
            </div>
            {r.contractViolations?.length ? (
              <p className="mb-2 text-xs text-danger" data-testid="contract-violation">
                Contract: {r.contractViolations.join("; ")}
              </p>
            ) : null}
            {r.reason && <p className="mb-2 text-xs text-muted-foreground">{r.reason}</p>}
            <div className="grid gap-2 md:grid-cols-3">
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Baseline</div>
                <JsonView value={r.baselineOutput} collapsedAt={400} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Target</div>
                <JsonView value={r.error ?? r.targetOutput} collapsedAt={400} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Human correction{r.note ? ` — “${r.note}”` : ""}
                </div>
                <JsonView value={r.kind === "approve" ? "approved as-is" : r.expected} collapsedAt={400} />
              </div>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

export default function ReplayPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: ["replay", id],
    queryFn: () => client.replays.get(id),
    refetchInterval: (q) =>
      q.state.data?.status === "pending" || q.state.data?.status === "running" ? 1500 : false,
  });
  const done =
    job.data?.status === "completed" || job.data?.status === "failed" || job.data?.status === "cancelled";
  const report = useQuery({
    queryKey: ["report", id, job.data?.status],
    queryFn: () => client.replays.report(id),
    enabled: done,
  });
  const cancel = useMutation({
    mutationFn: () => client.replays.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["replay", id] }),
  });

  if (!job.data) return <p className="text-sm text-muted-foreground">{job.error?.message ?? "Loading…"}</p>;
  const j = job.data;
  const s = j.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{j.targetModel}</h1>
            {j.targetPromptVersion && (
              <span className="font-mono text-sm text-muted-foreground">{j.targetPromptVersion}</span>
            )}
            <StatusBadge status={j.status} />
            <span className="text-xs text-muted-foreground">{j.mode} mode</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {j.id} · estimated {money(j.estimatedCostUsd)}
            {j.maxCostUsd != null && ` · cap ${money(j.maxCostUsd)}`}
          </p>
        </div>
        {!done && (
          <Button variant="outline" className="ml-auto" onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        )}
      </div>

      {!done && (
        <div className="rounded-lg border p-4 text-sm">
          <div className="mb-2 flex justify-between">
            <span>
              {j.completedCount} / {j.caseCount} cases
            </span>
            <span className="text-muted-foreground">{money(j.costUsd)} spent</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${j.caseCount ? (100 * j.completedCount) / j.caseCount : 0}%` }}
            />
          </div>
          {j.mode === "trajectory" && j.status === "pending" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Waiting for results from the CLI: run{" "}
              <code>overturn replay --mode trajectory --model {j.targetModel}</code> in your agent's
              directory.
            </p>
          )}
        </div>
      )}
      {j.error && (
        <p className="rounded-md border border-danger/25 bg-danger/10 p-3 text-sm text-danger">{j.error}</p>
      )}

      {s && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardDescription>Pass rate</CardDescription>
              <CardTitle className="font-mono text-2xl font-normal tabular-nums">{pct(s.passRate)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {s.passed} passed · {s.failed} failed · {s.completed}/{s.cases} run
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Regressions</CardDescription>
              <CardTitle className="font-mono text-2xl font-normal tabular-nums text-danger">
                {s.verdicts.regression ?? 0}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">approved cases that now fail</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Fixed</CardDescription>
              <CardTitle className="font-mono text-2xl font-normal tabular-nums text-success">
                {s.verdicts.fixed ?? 0}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">corrected cases that now pass</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Cost · duration</CardDescription>
              <CardTitle className="font-mono text-2xl font-normal tabular-nums">
                {money(s.costUsd)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : "—"} · baseline:{" "}
              {s.baseline
                ? s.baseline.kind === "job"
                  ? `job ${s.baseline.jobId?.slice(-8)}`
                  : `recorded (${s.baseline.model ?? "?"})`
                : "none"}
              {s.stoppedByCostCap && " · stopped by cost cap"}
            </CardContent>
          </Card>
        </div>
      )}

      {report.data?.gate && (
        <p
          className={`rounded-md border p-3 text-sm ${report.data.gate.pass ? "border-success/25 bg-success/10 text-success" : "border-danger/25 bg-danger/10 text-danger"}`}
          data-testid="gate"
        >
          {report.data.gate.pass
            ? "Gate: green. No regressions and no unaccepted new paths."
            : `Gate: red — ${report.data.gate.reasons.join(", ")}.`}
        </p>
      )}

      {report.data && narrative(report.data).length > 0 && (
        <Card data-testid="narrative">
          <CardHeader>
            <CardTitle>What changed</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {narrative(report.data).map((l) => (
                <li key={l}>{l.replace(/\*\*/g, "").replace(/`/g, "")}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {report.data && (
        <div className="space-y-8">
          <Section title="Regressions" rows={report.data.regressions} tone="danger" jobId={id} />
          {(report.data.newPaths?.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold text-warning">
                New paths{" "}
                <span className="font-normal text-muted-foreground">({report.data.newPaths.length})</span>
              </h2>
              <p className="text-xs text-muted-foreground">
                The agent called a tool with no recording. Compare it with the recorded call and accept it as
                equivalent, or correct the run. Until then the gate stays red
                {report.data.gate?.newPathsBlock === false ? " (not on this project)" : ""}.
              </p>
              {report.data.newPaths.map((r) => (
                <NewPathRow key={r.caseId} r={r} jobId={id} />
              ))}
            </section>
          )}
          <Section title="Still wrong" rows={report.data.stillWrong} tone="warning" jobId={id} />
          <Section title="Fixed" rows={report.data.fixed} tone="success" jobId={id} />
          {report.data.unreplayable.length > 0 && (
            <Section title="Unreplayable" rows={report.data.unreplayable} tone="muted" jobId={id} />
          )}
          {report.data.errors.length > 0 && (
            <Section title="Errors" rows={report.data.errors} tone="muted" jobId={id} />
          )}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Passed ({report.data.passed.length})
            </summary>
            <div className="mt-3">
              <Section title="Passed" rows={report.data.passed} tone="muted" jobId={id} />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
