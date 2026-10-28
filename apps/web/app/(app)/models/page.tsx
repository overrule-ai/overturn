"use client";

import type { TrainedModel } from "@overturn-ai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { client } from "@/lib/api";
import { ago, money, pct } from "@/lib/utils";

const BASES = [
  "meta-llama/Meta-Llama-3.1-8B-Instruct-Reference",
  "meta-llama/Llama-3.3-70B-Instruct-Reference",
  "Qwen/Qwen3.5-9B",
  "Qwen/Qwen3.5-27B",
  "google/gemma-4-26B-A4B-it",
];
const LIVE = new Set(["exporting", "uploading", "training", "gating"]);

function StatusBadge({ s }: { s: TrainedModel["status"] }) {
  const variant =
    s === "promoted"
      ? "success"
      : s === "passed"
        ? "info"
        : s === "failed"
          ? "danger"
          : LIVE.has(s)
            ? "warning"
            : "muted";
  return <Badge variant={variant}>{s}</Badge>;
}

function TrainForm({ onDone }: { onDone: () => void }) {
  const [base, setBase] = useState(BASES[0]!);
  const [method, setMethod] = useState<"sft" | "dpo">("sft");
  const [agent, setAgent] = useState("");
  const [epochs, setEpochs] = useState("3");
  const stats = useQuery({
    queryKey: ["export-stats", method, agent],
    queryFn: () => client.exportStats({ format: method, agent: agent || undefined }),
  });
  const create = useMutation({
    mutationFn: () =>
      client.models.create({
        baseModel: base,
        method,
        epochs: Number(epochs),
        filter: { agent: agent || undefined },
      }),
    onSuccess: onDone,
  });
  const rows = stats.data?.rows ?? 0;
  const enough = rows >= 50;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Train an owned model</CardTitle>
        <CardDescription>
          Fine-tunes an open-weight base on this project's corrections (the same dataset{" "}
          <code className="text-xs">overturn export</code> gives you), then replays the whole suite against
          it. Nothing is promoted without you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Base model (Together)</Label>
            <Input
              list="bases"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              data-testid="train-base"
            />
            <datalist id="bases">
              {BASES.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label>Method</Label>
            <NativeSelect
              className="w-full"
              value={method}
              onChange={(e) => setMethod(e.target.value as "sft" | "dpo")}
            >
              <option value="sft">sft — imitate the human-approved answers</option>
              <option value="dpo">dpo — prefer the corrected answer over the agent's</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label>Agent (optional)</Label>
            <Input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="ticket-triage" />
          </div>
          <div className="space-y-1">
            <Label>Epochs</Label>
            <Input value={epochs} onChange={(e) => setEpochs(e.target.value)} />
          </div>
        </div>
        <p className="text-sm" data-testid="train-stats">
          {stats.data ? (
            <>
              <span className="font-medium">{rows}</span> {method} rows (
              {Object.entries(stats.data.byKind)
                .map(([k, n]) => `${n} ${k}`)
                .join(", ") || "none"}
              ) · ~{stats.data.approxTokens.toLocaleString()} tokens
              {!enough && (
                <span className="block text-muted-foreground">
                  Under 50 rows a fine-tune rarely beats the model you have. Put corrections in the prompt
                  first:{" "}
                  <Link className="underline" href="/replays/new">
                    replay with examples
                  </Link>{" "}
                  and measure the lift; train when the rows pile up.
                </span>
              )}
            </>
          ) : (
            "…"
          )}
        </p>
        {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
        <Button
          onClick={() => create.mutate()}
          disabled={!enough || create.isPending}
          data-testid="train-start"
        >
          {create.isPending ? "Starting…" : "Train and gate"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function ModelsPage() {
  const qc = useQueryClient();
  const models = useQuery({
    queryKey: ["models"],
    queryFn: client.models.list,
    refetchInterval: (q) => (q.state.data?.some((m) => LIVE.has(m.status) || m.shadow) ? 5000 : false),
  });
  const act = useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: "promote" | "retire" | "patch";
      body?: Record<string, unknown>;
    }) => (action === "patch" ? client.models.patch(id, body ?? {}) : client.models[action](id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold">Models</h1>
          <p className="text-sm text-muted-foreground">
            The ladder: export → corrections in the prompt → an owned model, gated by your suite, watched in
            shadow, promoted by you.
          </p>
        </div>
        <Button variant="outline" asChild>
          <a href="/docs/owned-models/" target="_blank" rel="noreferrer">
            How it works
          </a>
        </Button>
        <Button onClick={() => setShowForm((v) => !v)} data-testid="train-toggle">
          {showForm ? "Close" : "Train a model"}
        </Button>
      </div>
      {showForm && (
        <TrainForm
          onDone={() => {
            setShowForm(false);
            qc.invalidateQueries({ queryKey: ["models"] });
          }}
        />
      )}
      {act.error && <p className="text-sm text-destructive">{act.error.message}</p>}
      <div className="space-y-3">
        {models.data?.map((m) => (
          <div key={m.id} className="rounded-md border bg-card p-4" data-testid="model-row">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{m.name}</span>
              <StatusBadge s={m.status} />
              <span className="font-mono text-xs text-muted-foreground">
                {m.baseModel} · {m.method} · {m.epochs} epochs
              </span>
              <span className="ml-auto text-xs text-muted-foreground">{ago(m.createdAt)}</span>
            </div>
            <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">Dataset</div>
                {m.datasetStats
                  ? `${m.datasetStats.rows} rows · ~${m.datasetStats.approxTokens.toLocaleString()} tokens`
                  : "—"}
                {m.trainingCostUsd != null && ` · ${money(m.trainingCostUsd)} to train`}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Gate</div>
                {m.gate ? (
                  <span>
                    <span className={m.gate.pass ? "text-success" : "text-danger"}>
                      {m.gate.pass ? "green" : "red"}
                    </span>
                    {" · "}
                    {pct(m.gate.passRate ?? 0)}
                    {m.gate.incumbentPassRate != null &&
                      ` vs ${pct(m.gate.incumbentPassRate)} ${m.gate.incumbentModel}`}
                    {" · "}
                    {m.gate.regressions} regressions
                    {m.gate.replayJobId && (
                      <Link className="ml-2 underline" href={`/replays/${m.gate.replayJobId}`}>
                        report
                      </Link>
                    )}
                    {m.gate.reasons.length > 0 && (
                      <span className="block text-xs text-muted-foreground">{m.gate.reasons.join("; ")}</span>
                    )}
                  </span>
                ) : LIVE.has(m.status) ? (
                  <span className="text-muted-foreground">{m.status}…</span>
                ) : (
                  "—"
                )}
                {m.error && <span className="block text-xs text-danger">{m.error}</span>}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Shadow</div>
                {m.shadowStats ? (
                  <span>
                    {m.shadowStats.runs} live runs · matches humans{" "}
                    {m.shadowStats.scored
                      ? `${pct(m.shadowStats.passRate ?? 0)} (${m.shadowStats.scored} corrected)`
                      : "— (none corrected yet)"}
                    {" · "}agrees with production{" "}
                    {pct(m.shadowStats.runs ? m.shadowStats.agreesWithProduction / m.shadowStats.runs : 0)}
                  </span>
                ) : m.shadow ? (
                  <span className="text-muted-foreground">on · waiting for live runs</span>
                ) : (
                  "off"
                )}
              </div>
            </div>
            {m.servedAs && (
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                served as {m.servedAs}
                {m.serving &&
                  ` · endpoint ${m.serving.endpointId} · ${m.serving.hardware ?? m.serving.config.split("/").pop()} ×${m.serving.replicas} · ${m.serving.state.replace("DEPLOYMENT_STATE_", "").toLowerCase()}`}
                {m.status === "promoted" && " · ov.promotedModel() returns this"}
              </p>
            )}
            {m.trigger === "auto" && (
              <p className="mt-1 text-xs text-muted-foreground">
                Trained automatically (continuous retraining).
              </p>
            )}
            {m.status === "deploying" && (
              <p className="mt-2 text-xs text-muted-foreground">
                Provisioning the dedicated endpoint; the gate runs when it is ready.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {(m.status === "passed" || m.status === "promoted") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => act.mutate({ id: m.id, action: "patch", body: { shadow: !m.shadow } })}
                  data-testid="model-shadow"
                >
                  {m.shadow ? "Stop shadow" : "Run in shadow"}
                </Button>
              )}
              {m.status === "passed" && (
                <Button
                  size="sm"
                  onClick={() => act.mutate({ id: m.id, action: "promote" })}
                  data-testid="model-promote"
                >
                  Promote
                </Button>
              )}
              {m.status !== "retired" && !LIVE.has(m.status) && (
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: m.id, action: "retire" })}>
                  Retire
                </Button>
              )}
            </div>
          </div>
        ))}
        {models.data?.length === 0 && !showForm && (
          <p className="rounded-md border p-6 text-sm text-muted-foreground">
            No owned models yet. Start with corrections in the prompt (replay with examples) — when the rows
            pile up, train one here and let the suite decide.
          </p>
        )}
      </div>
    </div>
  );
}
