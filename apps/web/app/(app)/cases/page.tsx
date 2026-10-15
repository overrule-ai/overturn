"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { KindBadge, VerdictBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { client } from "@/lib/api";
import { ago } from "@/lib/utils";

function CasesList() {
  const params = useSearchParams();
  const [filters, setFilters] = useState({
    agent: params.get("agent") ?? "",
    kind: "",
    tag: "",
    status: "active",
    set: "",
  });
  const sets = useQuery({ queryKey: ["case-sets"], queryFn: client.cases.sets });
  const cases = useQuery({
    queryKey: ["cases", filters],
    queryFn: () =>
      client.cases.list({
        agent: filters.agent || undefined,
        kind: filters.kind || undefined,
        tag: filters.tag || undefined,
        status: filters.status,
        set: filters.set || undefined,
        limit: 200,
      }),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Cases</h1>
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
        <NativeSelect value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}>
          <option value="">any kind</option>
          {["approve", "edit", "reject", "escalate"].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </NativeSelect>
        {sets.data && sets.data.length > 0 && (
          <NativeSelect value={filters.set} onChange={(e) => setFilters({ ...filters, set: e.target.value })}>
            <option value="">any set</option>
            {sets.data.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        )}
        <NativeSelect
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="active">active</option>
          <option value="archived">archived</option>
        </NativeSelect>
        <Button asChild>
          <Link href="/replays/new">Replay these</Link>
        </Button>
      </div>
      <Table>
        <THead>
          <TR>
            <TH>Case</TH>
            <TH>Kind</TH>
            <TH>Agent</TH>
            <TH>Scorer</TH>
            <TH>Last verdict</TH>
            <TH>Origin run</TH>
            <TH>By</TH>
            <TH>Created</TH>
          </TR>
        </THead>
        <TBody>
          {cases.data?.items.map((c) => (
            <TR key={c.id}>
              <TD>
                <Link className="font-medium underline-offset-2 hover:underline" href={`/cases/${c.id}`}>
                  {c.title}
                </Link>
                {c.truncated && <span className="ml-2 text-xs text-amber-700">truncated</span>}
              </TD>
              <TD>
                <KindBadge kind={c.kind} />
              </TD>
              <TD>{c.agent}</TD>
              <TD className="font-mono text-xs">{c.scorer}</TD>
              <TD>
                <VerdictBadge verdict={c.lastVerdict} />
              </TD>
              <TD>
                <Link className="font-mono text-xs underline" href={`/runs/${c.runId}`}>
                  {c.runId.slice(-8)}
                </Link>
              </TD>
              <TD className="text-xs text-muted-foreground">{c.actor ?? ""}</TD>
              <TD className="text-muted-foreground">{ago(c.createdAt)}</TD>
            </TR>
          ))}
          {cases.data?.items.length === 0 && (
            <TR>
              <TD colSpan={8} className="py-8 text-center text-muted-foreground">
                No cases yet. Correct a run and it becomes one.
              </TD>
            </TR>
          )}
        </TBody>
      </Table>
    </div>
  );
}

export default function CasesPage() {
  return (
    <Suspense fallback={null}>
      <CasesList />
    </Suspense>
  );
}
