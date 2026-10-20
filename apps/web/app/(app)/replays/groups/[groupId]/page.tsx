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
