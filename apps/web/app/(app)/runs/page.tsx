"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { client } from "@/lib/api";
import { ago, money, pct } from "@/lib/utils";

export default function RunsPage() {
  const [filters, setFilters] = useState({ agent: "", tag: "", status: "", corrected: "", since: "" });
  const [cursor, setCursor] = useState<string | undefined>();
  const stats = useQuery({ queryKey: ["runs-stats"], queryFn: client.runs.stats });
  const lastReplay = useQuery({
    queryKey: ["replays", "last"],
    queryFn: () => client.replays.list({ limit: 1, status: "completed" }),
  });
  const runs = useQuery({
    queryKey: ["runs", filters, cursor],
    queryFn: () =>
      client.runs.list({
        agent: filters.agent || undefined,
        tag: filters.tag || undefined,
        status: filters.status || undefined,
        corrected: filters.corrected || undefined,
        since: filters.since
          ? new Date(Date.now() - Number(filters.since) * 86_400_000).toISOString()
          : undefined,
        cursor,
        limit: 50,
      }),
  });
  const last = lastReplay.data?.[0];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Human-corrected rate, last 7 days</CardDescription>
            <CardTitle className="font-mono text-3xl font-normal tabular-nums">
              {stats.data ? pct(stats.data.correctedRate7d) : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {stats.data ? `${stats.data.corrected7d} of ${stats.data.runs7d} runs corrected` : ""}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Pass rate of the last replay</CardDescription>
            <CardTitle className="font-mono text-3xl font-normal tabular-nums">
              {last?.summary ? pct(last.summary.passRate) : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {last ? (
              <Link className="underline" href={`/replays/${last.id}`}>
                {last.targetModel} · {last.summary?.verdicts.regression ?? 0} regressions ·{" "}
                {money(last.costUsd)}
              </Link>
            ) : (
              "No replays yet"
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Input
          placeholder="agent"
          className="w-40"
          value={filters.agent}
          onChange={(e) => setFilters({ ...filters, agent: e.target.value })}
        />
        <Input
          placeholder="tag"
          className="w-32"
          value={filters.tag}
          onChange={(e) => setFilters({ ...filters, tag: e.target.value })}
        />
        <NativeSelect
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="">any status</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
        </NativeSelect>
        <NativeSelect
          value={filters.corrected}
          onChange={(e) => setFilters({ ...filters, corrected: e.target.value })}
        >
          <option value="">corrected or not</option>
          <option value="true">corrected</option>
          <option value="false">not corrected</option>
        </NativeSelect>
        <NativeSelect
          value={filters.since}
          onChange={(e) => setFilters({ ...filters, since: e.target.value })}
        >
          <option value="">all time</option>
          <option value="1">last 24h</option>
          <option value="7">last 7 days</option>
          <option value="30">last 30 days</option>
        </NativeSelect>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFilters({ agent: "", tag: "", status: "", corrected: "", since: "" })}
        >
          Clear
        </Button>
      </div>

      <Table>
        <THead>
          <TR>
            <TH>Agent</TH>
            <TH>Version</TH>
            <TH>External id</TH>
            <TH>Status</TH>
            <TH>Steps</TH>
            <TH>Corrections</TH>
            <TH>Cost</TH>
            <TH>Tags</TH>
            <TH>Started</TH>
          </TR>
        </THead>
        <TBody>
          {runs.data?.items.map((r) => (
            <TR key={r.id}>
              <TD>
                <Link className="font-medium underline-offset-2 hover:underline" href={`/runs/${r.id}`}>
                  {r.agent}
                </Link>
              </TD>
              <TD className="text-muted-foreground">{r.agentVersion ?? ""}</TD>
              <TD className="font-mono text-xs">{r.externalId ?? r.id.slice(-8)}</TD>
              <TD>
                <StatusBadge status={r.status} />
              </TD>
              <TD>{r.stepCount}</TD>
              <TD>{r.correctionCount}</TD>
              <TD>{money(r.costUsd)}</TD>
              <TD className="text-xs text-muted-foreground">{r.tags.join(", ")}</TD>
              <TD className="text-muted-foreground">{ago(r.startedAt)}</TD>
            </TR>
          ))}
          {runs.data?.items.length === 0 && (
            <TR>
              <TD colSpan={9} className="py-8 text-center text-muted-foreground">
                No runs yet. Record one with the SDK or point an OpenTelemetry exporter at{" "}
                <code>/v1/traces</code>.
              </TD>
            </TR>
          )}
        </TBody>
      </Table>
      {runs.data?.nextCursor && (
        <Button variant="outline" onClick={() => setCursor(runs.data!.nextCursor!)}>
          Load more
        </Button>
      )}
    </div>
  );
}
