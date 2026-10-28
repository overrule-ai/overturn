"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { KindBadge, VerdictBadge } from "@/components/badges";
import { ContractEditor } from "@/components/contract-editor";
import { JsonView } from "@/components/json-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { client } from "@/lib/api";
import { ago, money, short } from "@/lib/utils";

const SCORERS = ["equals", "json_match", "tool_choice", "semantic", "judge", "not_equals", "should_escalate"];

export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const c = useQuery({ queryKey: ["case", id], queryFn: () => client.cases.get(id) });
  const history = useQuery({ queryKey: ["case-results", id], queryFn: () => client.replays.caseResults(id) });
  const [tags, setTags] = useState<string | null>(null);
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => client.cases.patch(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      setTags(null);
    },
  });

  if (c.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!c.data) return <p className="text-sm text-destructive">{c.error?.message ?? "Not found"}</p>;
  const k = c.data;
  const recordings = Object.entries(k.toolRecordings);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{k.title}</h1>
            <KindBadge kind={k.kind} />
            {k.status === "archived" && <Badge variant="muted">archived</Badge>}
            {k.status === "suppressed" && <Badge variant="warning">suppressed</Badge>}
            {k.truncated && <Badge variant="warning">truncated</Badge>}
            {k.duplicates > 0 && (
              <Badge variant="muted" title={`corrected the same way ${k.duplicates + 1} times`}>
                ×{k.duplicates + 1}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {k.agent} {k.agentVersion ?? ""} · recorded with {k.recordedModel ?? "?"} · from run{" "}
            <Link className="underline" href={`/runs/${k.runId}`}>
              {k.runId.slice(-8)}
            </Link>{" "}
            · {ago(k.createdAt)}
            {k.actor && ` · by ${k.actor}`}
          </p>
          {k.note && (
            <p className="mt-2 rounded-md border border-warning/25 bg-warning/10 p-2 text-sm text-warning">
              “{k.note}”
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {Array.isArray(k.scorerConfig.fields) && (
            <span className="text-xs text-muted-foreground" title="Only these fields decide pass/fail">
              scored on <span className="font-mono">{(k.scorerConfig.fields as string[]).join(", ")}</span>
              {k.scorerConfig.auto === true ? " (auto)" : ""}
            </span>
          )}
          <NativeSelect value={k.scorer} onChange={(e) => patch.mutate({ scorer: e.target.value })}>
            {SCORERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect>
          {k.status === "active" && (
            <Button
              variant="outline"
              onClick={() => patch.mutate({ status: "suppressed" })}
              data-testid="suppress"
            >
              Suppress
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => patch.mutate({ status: k.status === "active" ? "archived" : "active" })}
            data-testid="archive-restore"
          >
            {k.status === "active" ? "Archive" : "Restore"}
          </Button>
          <Button asChild>
            <Link href={`/replays/new?ids=${k.id}`}>Replay this case</Link>
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Tags:</span>
        {tags === null ? (
          <>
            {k.tags.map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setTags(k.tags.join(", "))}>
              edit
            </Button>
          </>
        ) : (
          <>
            <Input className="w-72" value={tags} onChange={(e) => setTags(e.target.value)} />
            <Button
              size="sm"
              onClick={() =>
                patch.mutate({
                  tags: tags
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTags(null)}>
              Cancel
            </Button>
          </>
        )}
      </div>

      <div className="space-y-1" data-testid="case-contract">
        <div className="text-xs font-medium text-muted-foreground">
          Contract — rules checked on every replay; a broken one is a regression
        </div>
        <ContractEditor
          value={k.contract}
          onChange={(contract) => patch.mutate({ contract })}
          tools={[...new Set(recordings.map(([, rec]) => rec.name))]}
          compact
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            {k.kind === "approve" ? "Expected (approved as-is by the human)" : "Expected (from the human)"}
          </div>
          <JsonView value={k.expected} />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Original output (what the agent did)
          </div>
          <JsonView value={k.originalOutput} />
        </div>
      </div>

      <Tabs defaultValue="input">
        <TabsList>
          <TabsTrigger value="input">Frozen input</TabsTrigger>
          <TabsTrigger value="tools">Tool recordings ({recordings.length})</TabsTrigger>
          <TabsTrigger value="history">Result history ({history.data?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="scorer">Scorer config</TabsTrigger>
        </TabsList>
        <TabsContent value="input">
          <JsonView value={k.frozenInput} collapsedAt={4000} />
        </TabsContent>
        <TabsContent value="tools">
          {recordings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tool calls in this run.</p>
          ) : (
            <div className="space-y-2">
              {recordings.map(([fp, rec]) => (
                <div key={fp} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm">
                    <span className="font-medium">{rec.name}</span>
                    {rec.sideEffect && <Badge variant="warning">side effect · refused in replay</Badge>}
                    {rec.equivalentOf && (
                      <Badge variant="info" title={rec.note ?? undefined}>
                        accepted path{rec.acceptedBy ? ` · ${rec.acceptedBy}` : ""}
                        {rec.note ? ` · “${rec.note}”` : ""}
                      </Badge>
                    )}
                    <span className="ml-auto font-mono text-xs text-muted-foreground">{fp.slice(0, 12)}</span>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <JsonView value={rec.args} />
                    <JsonView value={rec.output} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="history">
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Model</TH>
                <TH>Mode</TH>
                <TH>Verdict</TH>
                <TH>Score</TH>
                <TH>Output</TH>
                <TH>Why</TH>
                <TH>Cost</TH>
              </TR>
            </THead>
            <TBody>
              {history.data?.map((r) => (
                <TR key={r.id}>
                  <TD className="text-muted-foreground">
                    <Link className="underline" href={`/replays/${r.jobId}`}>
                      {ago(r.createdAt)}
                    </Link>
                  </TD>
                  <TD className="font-mono text-xs">
                    {r.targetModel}
                    {r.targetPromptVersion ? ` · ${r.targetPromptVersion}` : ""}
                  </TD>
                  <TD>{r.mode}</TD>
                  <TD>
                    <VerdictBadge verdict={r.verdict} />
                  </TD>
                  <TD>{r.score?.toFixed(2) ?? "—"}</TD>
                  <TD className="max-w-xs truncate font-mono text-xs">{short(r.error ?? r.output, 60)}</TD>
                  <TD className="max-w-xs truncate text-xs text-muted-foreground">{r.reason}</TD>
                  <TD>{money(r.costUsd)}</TD>
                </TR>
              ))}
              {history.data?.length === 0 && (
                <TR>
                  <TD colSpan={8} className="py-6 text-center text-muted-foreground">
                    Not replayed yet.
                  </TD>
                </TR>
              )}
            </TBody>
          </Table>
        </TabsContent>
        <TabsContent value="scorer">
          <JsonView value={{ scorer: k.scorer, config: k.scorerConfig }} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
