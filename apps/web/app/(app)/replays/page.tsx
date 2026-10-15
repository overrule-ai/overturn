"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { StatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { client } from "@/lib/api";
import { ago, money, pct } from "@/lib/utils";

export default function ReplaysPage() {
  const jobs = useQuery({
    queryKey: ["replays"],
    queryFn: () => client.replays.list({ limit: 50 }),
    refetchInterval: 3000,
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <h1 className="text-xl font-semibold">Replays</h1>
        <Button asChild className="ml-auto">
          <Link href="/replays/new">New replay</Link>
        </Button>
      </div>
      <Table>
        <THead>
          <TR>
            <TH>Model</TH>
            <TH>Prompt</TH>
            <TH>Mode</TH>
            <TH>Status</TH>
            <TH>Cases</TH>
            <TH>Pass rate</TH>
            <TH>Regressions</TH>
            <TH>Fixed</TH>
            <TH>Cost</TH>
            <TH>Created</TH>
          </TR>
        </THead>
        <TBody>
          {jobs.data?.map((j) => (
            <TR key={j.id}>
              <TD>
                <Link className="font-medium underline-offset-2 hover:underline" href={`/replays/${j.id}`}>
                  {j.targetModel}
                </Link>
              </TD>
              <TD className="font-mono text-xs">{j.targetPromptVersion ?? ""}</TD>
              <TD>{j.mode}</TD>
              <TD>
                <StatusBadge status={j.status} />
              </TD>
              <TD>
                {j.completedCount}/{j.caseCount}
              </TD>
              <TD>{j.summary ? pct(j.summary.passRate) : "—"}</TD>
              <TD className={j.summary?.verdicts.regression ? "font-medium text-red-700" : ""}>
                {j.summary?.verdicts.regression ?? "—"}
              </TD>
              <TD className={j.summary?.verdicts.fixed ? "font-medium text-emerald-700" : ""}>
                {j.summary?.verdicts.fixed ?? "—"}
              </TD>
              <TD>{money(j.costUsd)}</TD>
              <TD className="text-muted-foreground">{ago(j.createdAt)}</TD>
            </TR>
          ))}
          {jobs.data?.length === 0 && (
            <TR>
              <TD colSpan={10} className="py-8 text-center text-muted-foreground">
                No replays yet.
              </TD>
            </TR>
          )}
        </TBody>
      </Table>
    </div>
  );
}
