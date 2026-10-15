"use client";

import type { ReportRow } from "@overturn-ai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { KindBadge, StatusBadge, VerdictBadge } from "@/components/badges";
import { JsonView } from "@/components/json-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { client } from "@/lib/api";
import { money, pct } from "@/lib/utils";

function Section({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: ReportRow[];
  tone: "danger" | "warning" | "success" | "muted";
}) {
  const color =
    tone === "danger"
      ? "text-red-700"
      : tone === "warning"
        ? "text-amber-700"
        : tone === "success"
          ? "text-emerald-700"
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
              <span className="ml-auto text-xs text-muted-foreground">
                {r.scorer}
                {r.score != null && ` · ${r.score.toFixed(2)}`}
                {r.latencyMs != null && ` · ${Math.round(r.latencyMs)} ms`}
                {r.costUsd != null && ` · ${money(r.costUsd)}`}
              </span>
            </div>
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
      {j.error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-800">{j.error}</p>}

      {s && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardDescription>Pass rate</CardDescription>
              <CardTitle className="text-2xl">{pct(s.passRate)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {s.passed} passed · {s.failed} failed · {s.completed}/{s.cases} run
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Regressions</CardDescription>
              <CardTitle className="text-2xl text-red-700">{s.verdicts.regression ?? 0}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">approved cases that now fail</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Fixed</CardDescription>
              <CardTitle className="text-2xl text-emerald-700">{s.verdicts.fixed ?? 0}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">corrected cases that now pass</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Cost · duration</CardDescription>
              <CardTitle className="text-2xl">{money(s.costUsd)}</CardTitle>
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

      {report.data && (
        <div className="space-y-8">
          <Section title="Regressions" rows={report.data.regressions} tone="danger" />
          <Section title="Still wrong" rows={report.data.stillWrong} tone="warning" />
          <Section title="Fixed" rows={report.data.fixed} tone="success" />
          {report.data.unreplayable.length > 0 && (
            <Section title="Unreplayable" rows={report.data.unreplayable} tone="muted" />
          )}
          {report.data.errors.length > 0 && <Section title="Errors" rows={report.data.errors} tone="muted" />}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Passed ({report.data.passed.length})
            </summary>
            <div className="mt-3">
              <Section title="Passed" rows={report.data.passed} tone="muted" />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
