"use client";

import type { CorrectionKind, Step } from "@overturn/shared";
import { extractAnswer } from "@overturn/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { client } from "@/lib/api";
import { cn } from "@/lib/utils";

const KINDS: Array<{ kind: CorrectionKind; label: string; help: string }> = [
  { kind: "approve", label: "Approve", help: "The agent was right. Makes a positive case." },
  { kind: "edit", label: "Edit", help: "Here is the right output." },
  { kind: "reject", label: "Reject", help: "Wrong, no replacement. Add a note for the judge." },
  { kind: "escalate", label: "Escalate", help: "A human should have taken over." },
];

export function CorrectDialog({
  runId,
  step,
  runOutput,
  open,
  onOpenChange,
}: {
  runId: string;
  step: Step | null;
  runOutput: unknown;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const original = step ? extractAnswer(step.output) : runOutput;
  const [kind, setKind] = useState<CorrectionKind>("approve");
  const [text, setText] = useState(() =>
    typeof original === "string" ? original : JSON.stringify(original ?? null, null, 2),
  );
  const [note, setNote] = useState("");
  const [actor, setActor] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      let correctedOutput: unknown;
      if (kind === "edit") {
        const t = text.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
          try {
            correctedOutput = JSON.parse(t);
          } catch (e) {
            throw new Error(`Corrected output is not valid JSON: ${(e as Error).message}`);
          }
        } else correctedOutput = t;
      }
      return client.corrections.create({
        runId,
        stepId: step?.id ?? null,
        kind,
        correctedOutput,
        note: note || null,
        actor: actor || null,
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["run", runId] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      onOpenChange(false);
      if (r.case) router.push(`/cases/${r.case.id}`);
    },
    onError: (e: Error) => setParseError(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Correct {step ? `step ${step.seq}: ${step.name}` : "this run"}</DialogTitle>
        <DialogDescription>
          Every correction becomes a regression case with this step's exact input and the run's tool
          recordings frozen.
        </DialogDescription>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => setKind(k.kind)}
              className={cn(
                "rounded-md border p-2 text-left text-sm hover:bg-accent",
                kind === k.kind && "border-primary bg-accent",
              )}
            >
              <div className="font-medium">{k.label}</div>
              <div className="text-xs text-muted-foreground">{k.help}</div>
            </button>
          ))}
        </div>
        {kind === "edit" && (
          <div className="mt-4 space-y-1">
            <Label>Corrected output (JSON or text)</Label>
            <Textarea
              className="min-h-[160px] font-mono text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}
        <div className="mt-4 space-y-1">
          <Label>
            Note {kind === "reject" || kind === "escalate" ? "(used as the judge rubric)" : "(optional)"}
          </Label>
          <Textarea
            placeholder="Why? e.g. Enterprise customer, outage keyword in body"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="mt-3 space-y-1">
          <Label>Actor (optional)</Label>
          <input
            className="flex h-9 w-full rounded-md border px-3 text-sm"
            placeholder="you@company.com"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </div>
        {parseError && <p className="mt-2 text-sm text-destructive">{parseError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending ? "Saving…" : `Save ${kind}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
