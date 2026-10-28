"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  const qc = useQueryClient();
  const sets = useQuery({ queryKey: ["case-sets"], queryFn: client.cases.sets });
  // suppressed and archived counts stay visible so the suite never shrinks silently
  const counts = useQuery({ queryKey: ["case-counts"], queryFn: client.cases.counts });
  const restore = useMutation({
    mutationFn: (id: string) => client.cases.patch(id, { status: "active" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case-counts"] });
      qc.invalidateQueries({ queryKey: ["case-conflicts"] });
    },
  });
  const conflicts = useQuery({
    queryKey: ["case-conflicts"],
    queryFn: client.cases.conflicts,
    enabled: (counts.data?.conflicts ?? 0) > 0,
  });
  const dedupe = useMutation({
    mutationFn: () => client.cases.dedupe(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case-counts"] });
      qc.invalidateQueries({ queryKey: ["case-conflicts"] });
    },
  });
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
          <option value="active">active{counts.data ? ` (${counts.data.active})` : ""}</option>
          <option value="suppressed">suppressed{counts.data ? ` (${counts.data.suppressed})` : ""}</option>
          <option value="archived">archived{counts.data ? ` (${counts.data.archived})` : ""}</option>
        </NativeSelect>
        <Button asChild>
          <Link
            href={`/replays/new?${new URLSearchParams(
              Object.fromEntries(
                Object.entries({ agent: filters.agent, tag: filters.tag, set: filters.set }).filter(
                  ([, v]) => v,
                ),
              ),
            ).toString()}`}
          >
            Replay these
          </Link>
        </Button>
      </div>
      {counts.data && counts.data.suppressed > 0 && filters.status === "active" && (
        <p className="text-xs text-muted-foreground" data-testid="suppressed-note">
          {counts.data.suppressed} case{counts.data.suppressed === 1 ? "" : "s"} suppressed from the suite.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setFilters({ ...filters, status: "suppressed" })}
          >
            Review them
          </button>
        </p>
      )}
      {counts.data && counts.data.conflicts > 0 && (
        <div
          className="rounded-md border border-warning/25 bg-warning/10 p-3 text-sm"
          data-testid="conflicts-note"
        >
          <p className="font-medium">
            {counts.data.conflicts} input{counts.data.conflicts === 1 ? " has" : "s have"} conflicting
            corrections.
          </p>
          <p className="text-xs text-muted-foreground">
            The same input was corrected to different answers, so every replay fails at least one side.
            Suppress the one that is wrong, or re-correct the run.
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {(conflicts.data ?? []).slice(0, 10).map((c) => (
              <li key={c.inputHash} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-muted-foreground">{c.agent}</span>
                {c.cases.map((k) => (
                  <Link key={k.id} className="underline" href={`/cases/${k.id}`}>
                    {k.kind}
                    {k.actor ? ` by ${k.actor}` : ""}: {JSON.stringify(k.expected).slice(0, 60)}
                  </Link>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The same input corrected to the same answer again merges into one case (shown as “×N”).{" "}
        <button
          type="button"
          className="underline"
          onClick={() => dedupe.mutate()}
          disabled={dedupe.isPending}
          data-testid="dedupe"
        >
          {dedupe.isPending ? "Merging…" : "Merge older duplicates"}
        </button>
        {dedupe.data && (
          <span data-testid="dedupe-result">
            {" "}
            —{" "}
            {dedupe.data.merged === 0
              ? "no duplicates found."
              : `merged ${dedupe.data.merged} into ${dedupe.data.kept}.`}
          </span>
        )}
      </p>
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
                {c.truncated && <span className="ml-2 text-xs text-warning">truncated</span>}
                {c.duplicates > 0 && (
                  <span
                    className="ml-2 text-xs text-muted-foreground"
                    title={`corrected the same way ${c.duplicates + 1} times`}
                  >
                    ×{c.duplicates + 1}
                  </span>
                )}
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
              <TD className="text-muted-foreground">
                {ago(c.createdAt)}
                {c.status !== "active" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-2 h-6 px-2 text-xs"
                    onClick={() => restore.mutate(c.id)}
                    disabled={restore.isPending}
                    data-testid="restore-case"
                  >
                    Restore
                  </Button>
                )}
              </TD>
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
