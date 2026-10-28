"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { KindBadge, StatusBadge, VerdictBadge } from "@/components/badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { client } from "@/lib/api";
import { money, pct } from "@/lib/utils";

const DONE = new Set(["completed", "failed", "cancelled"]);

export default function ReplayMatrixPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const matrix = useQuery({
    queryKey: ["replay-matrix", groupId],
    queryFn: () => client.replays.matrix(groupId),
    refetchInterval: (q) => (q.state.data?.jobs.every((j) => DONE.has(j.status)) ? false : 1500),
  });
  if (!matrix.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const m = matrix.data;
  const regressions = (jobId: string) =>
    m.cases.filter((c) => c.cells[jobId]?.verdict === "regression").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {m.cases.length} cases × {m.jobs.length} models
        </h1>
        <p className="text-sm text-muted-foreground">
          Same cases, same prompt, different models. One column per model; click a model for its full report.
        </p>
      </div>

      {m.scorecard && m.scorecard.length > 1 && (
        <div className="rounded-md border" data-testid="scorecard">
          <div className="border-b px-4 py-3">
            <h2 className="text-base font-medium">Challenger scorecard</h2>
            <p className="text-xs text-muted-foreground">
              Same cases, same corrections. The incumbent is the model the cases were recorded with; every
              other row is measured against it.
            </p>
          </div>
          <Table>
            <THead>
              <TR>
                <TH>Model</TH>
                <TH>Pass rate</TH>
                <TH>Regressions</TH>
                <TH>Cost / call</TH>
                <TH>p50 latency</TH>
                <TH>vs incumbent</TH>
              </TR>
            </THead>
            <TBody>
              {m.scorecard.map((r) => (
                <TR key={r.jobId}>
                  <TD className="font-mono text-xs">
                    <Link className="underline-offset-2 hover:underline" href={`/replays/${r.jobId}`}>
                      {r.model}
                    </Link>
                    {(m.jobs.find((j) => j.id === r.jobId)?.options.examples ?? 0) > 0 && (
                      <span className="ml-2 text-muted-foreground">
                        +{m.jobs.find((j) => j.id === r.jobId)?.options.examples} examples
                      </span>
                    )}
                    {r.incumbent && <span className="ml-2 text-muted-foreground">incumbent</span>}
                  </TD>
                  <TD className="font-mono tabular-nums">
                    {r.passRate != null ? pct(r.passRate) : r.status}
                  </TD>
                  <TD className={r.regressions ? "font-medium text-danger" : ""}>{r.regressions}</TD>
                  <TD className="font-mono tabular-nums">
                    {r.costPerCallUsd != null
                      ? `$${r.costPerCallUsd.toFixed(4)}`
                      : r.pricePerMTokens
                        ? `$${r.pricePerMTokens[0]}/$${r.pricePerMTokens[1]} per M`
                        : "—"}
                  </TD>
                  <TD className="font-mono tabular-nums">
                    {r.latencyP50Ms != null ? `${Math.round(r.latencyP50Ms)} ms` : "—"}
                  </TD>
                  <TD className="text-xs">
                    {r.incumbent || !r.vsIncumbent ? (
                      "—"
                    ) : (
                      <span>
                        {r.vsIncumbent.passRatePoints != null && (
                          <span
                            className={
                              r.vsIncumbent.passRatePoints >= 0
                                ? "text-success"
                                : r.vsIncumbent.passRatePoints > -5
                                  ? "text-warning"
                                  : "text-danger"
                            }
                          >
                            {r.vsIncumbent.passRatePoints >= 0 ? "+" : ""}
                            {r.vsIncumbent.passRatePoints} pts
                          </span>
                        )}
                        {r.vsIncumbent.costRatio != null && (
                          <span className="ml-2 text-muted-foreground">
                            {r.vsIncumbent.costRatio < 1
                              ? `${Math.round((1 / r.vsIncumbent.costRatio) * 10) / 10}× cheaper`
                              : `${r.vsIncumbent.costRatio}× the cost`}
                          </span>
                        )}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {(() => {
            const inc = m.scorecard.find((r) => r.incumbent);
            const best = m.scorecard
              .filter(
                (r) =>
                  !r.incumbent &&
                  r.vsIncumbent?.costRatio != null &&
                  r.vsIncumbent.costRatio < 1 &&
                  r.regressions === 0 &&
                  (r.vsIncumbent.passRatePoints ?? -1) >= -2,
              )
              .sort((a, b) => (a.vsIncumbent!.costRatio ?? 1) - (b.vsIncumbent!.costRatio ?? 1))[0];
            return best && inc ? (
              <p className="border-t px-4 py-3 text-sm" data-testid="scorecard-verdict">
                <span className="font-medium">{best.model}</span> holds your pass rate with no regressions at{" "}
                {Math.round((1 / (best.vsIncumbent!.costRatio ?? 1)) * 10) / 10}× less than {inc.model}.
                Fine-tune it on your corrections and it usually pulls ahead.
              </p>
            ) : null;
          })()}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {m.jobs.map((j) => (
          <Card key={j.id}>
            <CardHeader className="pb-2">
              <CardDescription className="truncate font-mono text-xs">
                <Link className="underline-offset-2 hover:underline" href={`/replays/${j.id}`}>
                  {j.targetModel}
                </Link>
              </CardDescription>
              <CardTitle className="font-mono text-2xl font-normal tabular-nums">
                {j.summary ? pct(j.summary.passRate) : <StatusBadge status={j.status} />}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              <span className={regressions(j.id) ? "font-medium text-danger" : ""}>
                {regressions(j.id)} regressions
              </span>{" "}
              · {j.summary?.verdicts.fixed ?? 0} fixed · {money(j.costUsd)}
            </CardContent>
          </Card>
        ))}
      </div>

      <Table>
        <THead>
          <TR>
            <TH>Case</TH>
            {m.jobs.map((j) => (
              <TH key={j.id} className="font-mono">
                {j.targetModel}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {m.cases.map((c) => (
            <TR key={c.caseId}>
              <TD>
                <Link className="underline-offset-2 hover:underline" href={`/cases/${c.caseId}`}>
                  {c.title}
                </Link>{" "}
                <KindBadge kind={c.kind} />
              </TD>
              {m.jobs.map((j) => {
                const cell = c.cells[j.id];
                return (
                  <TD key={j.id} title={cell?.reason ?? ""}>
                    <VerdictBadge verdict={cell?.verdict} />
                  </TD>
                );
              })}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
