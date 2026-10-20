"use client";

import type { Step } from "@overturn-ai/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { KindBadge, StatusBadge } from "@/components/badges";
import { CorrectDialog } from "@/components/correct-dialog";
import { JsonView } from "@/components/json-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/api";
import { ago, cn, money } from "@/lib/utils";

function StepRow({ step, onCorrect }: { step: Step; onCorrect: () => void }) {
  const [open, setOpen] = useState(false);
  const kindVariant =
    step.kind === "llm_call"
      ? "info"
      : step.kind === "tool_call"
        ? step.sideEffect
          ? "warning"
          : "secondary"
        : "muted";
  return (
    <li className="relative pl-8">
      <span
        className={cn(
          "absolute left-2 top-3 h-3 w-3 rounded-full border-2 border-background",
          step.error ? "bg-red-500" : step.kind === "llm_call" ? "bg-sky-500" : "bg-neutral-400",
        )}
      />
      <div className="rounded-lg border">
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm"
          onClick={() => setOpen((o) => !o)}
          data-testid={`step-${step.seq}`}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="w-8 text-xs text-muted-foreground">#{step.seq}</span>
          <Badge variant={kindVariant}>{step.kind}</Badge>
          <span className="font-medium">{step.name}</span>
          {step.model && <span className="text-xs text-muted-foreground">{step.model}</span>}
          {step.sideEffect && <Badge variant="warning">side effect</Badge>}
          {step.error && <Badge variant="danger">error</Badge>}
          <span className="ml-auto hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
            {step.latencyMs != null && <span>{Math.round(step.latencyMs)} ms</span>}
            {step.costUsd != null && <span>{money(step.costUsd)}</span>}
            {step.usage?.inputTokens != null && (
              <span>
                {step.usage.inputTokens}→{step.usage.outputTokens ?? 0} tok
              </span>
            )}
          </span>
          {step.kind === "llm_call" && (
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                onCorrect();
              }}
            >
              Correct
            </Button>
          )}
        </button>
        {open && (
          <div className="grid gap-3 border-t p-3 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Input</div>
              <JsonView value={step.input} />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {step.error ? "Error" : "Output"}
              </div>
              <JsonView value={step.error ?? step.output} />
            </div>
            {step.params && Object.keys(step.params).length > 0 && (
              <div className="md:col-span-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Params</div>
                <JsonView value={step.params} />
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const run = useQuery({ queryKey: ["run", id], queryFn: () => client.runs.get(id) });
  const corrections = useQuery({ queryKey: ["corrections", id], queryFn: () => client.corrections.list(id) });
  const [dialog, setDialog] = useState<{ step: Step | null } | null>(null);

  // ?approve=1 (the Approve button in the Slack review message) opens the run-level
  // approve dialog; the correction is only written when the human confirms.
  useEffect(() => {
    if (!run.data) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("approve") === "1") {
      setDialog({ step: null });
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [run.data]);

  if (run.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (run.error || !run.data)
    return <p className="text-sm text-destructive">{run.error?.message ?? "Not found"}</p>;
  const r = run.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{r.agent}</h1>
            {r.agentVersion && <span className="text-sm text-muted-foreground">{r.agentVersion}</span>}
            <StatusBadge status={r.status} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {r.externalId ? `${r.externalId} · ` : ""}
            {r.id} · started {ago(r.startedAt)} · {r.stepCount} steps · {money(r.costUsd)}
            {r.tags.length > 0 && ` · ${r.tags.join(", ")}`}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => setDialog({ step: null })} data-testid="correct-run">
            Correct run
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Run input</div>
          <JsonView value={r.input} />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Run output</div>
          <JsonView value={r.error ?? r.output} />
        </div>
      </div>

      {corrections.data && corrections.data.length > 0 && (
        <div className="rounded-lg border p-3 text-sm">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Corrections</div>
          <ul className="space-y-1">
            {corrections.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <KindBadge kind={c.kind} />
                <span>{c.stepId ? "step" : "run"}</span>
                {c.note && <span className="min-w-0 flex-1 basis-48 text-muted-foreground">— {c.note}</span>}
                <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
                  {c.actor ?? c.source} · {ago(c.createdAt)}
                </span>
                <Link className="text-xs underline" href={`/cases?runId=${r.id}`}>
                  case
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-medium">Trajectory</h2>
        <ol className="relative space-y-2 border-l border-border/70 pl-0">
          {r.steps.map((s) => (
            <StepRow key={s.id} step={s} onCorrect={() => setDialog({ step: s })} />
          ))}
        </ol>
      </div>

      {dialog && (
        <CorrectDialog
          runId={r.id}
          step={dialog.step}
          runOutput={r.output}
          open
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
    </div>
  );
}
