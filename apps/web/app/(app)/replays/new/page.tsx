"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { client } from "@/lib/api";
import { money } from "@/lib/utils";

const SUGGESTED = [
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5",
  "google/gemini-2.5-flash",
  "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "together/Qwen/Qwen2.5-72B-Instruct-Turbo",
  "together/meta-llama/Llama-3.1-8B-Instruct-Turbo",
  "fake/fake-triage-weak",
];

/** Open-weight challengers: replayed next to the incumbent, the scorecard shows who matches it for less. */
const CHALLENGERS = [
  "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "together/Qwen/Qwen2.5-72B-Instruct-Turbo",
  "together/meta-llama/Llama-3.1-8B-Instruct-Turbo",
];

export default function NewReplayPage() {
  const router = useRouter();
  const [model, setModel] = useState("openai/gpt-4.1-mini");
  const [mode, setMode] = useState<"step" | "trajectory">("step");
  const [agent, setAgent] = useState("");
  const [tag, setTag] = useState("");
  const [set, setSet] = useState("");
  const [since, setSince] = useState("30");
  const [prompt, setPrompt] = useState("");
  const [maxCost, setMaxCost] = useState("");
  // ?ids=a,b (from a case page) or ?agent=&tag=&set= (from the cases list) preselect the cases
  const [ids, setIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const list = (q.get("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) {
      setIds(list);
      setSince("");
    }
    if (q.get("agent")) setAgent(q.get("agent") ?? "");
    if (q.get("tag")) setTag(q.get("tag") ?? "");
    if (q.get("set")) setSet(q.get("set") ?? "");
    setReady(true);
  }, []);
  const sets = useQuery({ queryKey: ["case-sets"], queryFn: client.cases.sets });
  const prompts = useQuery({ queryKey: ["prompts"], queryFn: client.prompts.list });

  const filter = {
    ids: ids.length > 0 ? ids : undefined,
    agent: agent || undefined,
    tag: tag || undefined,
    set: set || undefined,
    since: since ? new Date(Date.now() - Number(since) * 86_400_000).toISOString() : undefined,
  };
  // "a/b, c/d" replays the same cases against several models and lands on the matrix
  const models = model
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const first = models[0] ?? "";
  const estimate = useMutation({ mutationFn: () => client.replays.estimate({ model: first, filter }) });
  // biome-ignore lint/correctness/useExhaustiveDependencies: estimate is a stable mutation handle
  useEffect(() => {
    if (ready && first.includes("/")) estimate.mutate();
  }, [ready, first, agent, tag, set, since, ids]);

  const create = useMutation({
    mutationFn: () =>
      client.replays.create({
        model: first,
        ...(models.length > 1 ? { models: models.slice(1) } : {}),
        mode,
        filter,
        promptVersion: prompt || null,
        maxCostUsd: maxCost ? Number(maxCost) : null,
        start: mode === "step",
      }),
    onSuccess: ({ job, jobs }) =>
      router.push(jobs.length > 1 && job.groupId ? `/replays/groups/${job.groupId}` : `/replays/${job.id}`),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">New replay</h1>
      <Card>
        <CardHeader>
          <CardTitle>Target</CardTitle>
          <CardDescription>Which model or prompt to replay the cases against.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Model (provider/model) — comma-separate several to compare them</Label>
            <Input
              list="models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              data-testid="model"
            />
            <datalist id="models">
              {SUGGESTED.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                const current = models.filter((m) => !CHALLENGERS.includes(m));
                setModel([...current, ...CHALLENGERS].join(", "));
              }}
              data-testid="add-challengers"
            >
              + Challenge with open-weight models (Llama 3.3 70B, Qwen 2.5 72B, Llama 3.1 8B on Together)
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Mode</Label>
              <NativeSelect
                className="w-full"
                value={mode}
                onChange={(e) => setMode(e.target.value as "step" | "trajectory")}
              >
                <option value="step">step — the corrected model call, on the server</option>
                <option value="trajectory">trajectory — whole run through overturn.config.ts (CLI)</option>
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>Prompt version (optional)</Label>
              <NativeSelect className="w-full" value={prompt} onChange={(e) => setPrompt(e.target.value)}>
                <option value="">as recorded</option>
                {prompts.data?.map((p) => (
                  <option key={p.id} value={`${p.name}@${p.version}`}>
                    {p.name}@{p.version}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cases</CardTitle>
          <CardDescription>Filter, or pick a saved set.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {ids.length > 0 && (
            <p className="text-sm sm:col-span-2" data-testid="selected-cases">
              {ids.length} selected case{ids.length === 1 ? "" : "s"} ·{" "}
              <button type="button" className="underline" onClick={() => setIds([])}>
                clear
              </button>
            </p>
          )}
          <div className="space-y-1">
            <Label>Agent</Label>
            <Input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="any" />
          </div>
          <div className="space-y-1">
            <Label>Tag</Label>
            <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="any" />
          </div>
          <div className="space-y-1">
            <Label>Saved set</Label>
            <NativeSelect className="w-full" value={set} onChange={(e) => setSet(e.target.value)}>
              <option value="">none</option>
              {sets.data?.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label>Created in the last</Label>
            <NativeSelect className="w-full" value={since} onChange={(e) => setSince(e.target.value)}>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="">all time</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label>Max cost (USD, optional)</Label>
            <Input
              type="number"
              step="0.5"
              min="0"
              value={maxCost}
              onChange={(e) => setMaxCost(e.target.value)}
              placeholder="no cap"
            />
          </div>
        </CardContent>
      </Card>
      <div className="flex items-center gap-4 rounded-lg border p-4 text-sm">
        <div>
          {estimate.data ? (
            <>
              <span className="font-medium">{estimate.data.cases} cases</span> · estimated{" "}
              {estimate.data.priced ? money(estimate.data.estimatedCostUsd) : "cost unknown for this model"} (
              {estimate.data.estimatedInputTokens.toLocaleString()} in /{" "}
              {estimate.data.estimatedOutputTokens.toLocaleString()} out tokens)
              {models.length > 1 ? ` · ×${models.length} models` : ""}
            </>
          ) : estimate.error ? (
            <span className="text-destructive">{estimate.error.message}</span>
          ) : (
            "Estimating…"
          )}
        </div>
        <Button
          className="ml-auto"
          disabled={create.isPending || !estimate.data || estimate.data.cases === 0}
          onClick={() => create.mutate()}
          data-testid="start-replay"
        >
          {create.isPending ? "Starting…" : mode === "step" ? "Start replay" : "Create job"}
        </Button>
      </div>
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      {mode === "trajectory" && (
        <p className="text-xs text-muted-foreground">
          Trajectory mode runs in your environment:{" "}
          <code>overturn replay --mode trajectory --model {model}</code> from the directory with your{" "}
          <code>overturn.config.ts</code>.
        </p>
      )}
    </div>
  );
}
