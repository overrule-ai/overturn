"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { client, getApiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

type Lang = "ts" | "py" | "otel";

function snippet(lang: Lang, key: string, apiUrl: string): string {
  const k = key || "ov_live_…";
  if (lang === "ts")
    return `npm i @overturn-ai/sdk

export OVERTURN_API_KEY=${k}
export OVERTURN_BASE_URL=${apiUrl}

import { Overturn } from "@overturn-ai/sdk";
import OpenAI from "openai";

const ov = new Overturn();                       // reads the two env vars
const openai = ov.wrapOpenAI(new OpenAI());      // every model call is recorded

const run = ov.startRun({ agent: "my-agent", input });
await run.context(async () => {
  const res = await openai.chat.completions.create({ model, messages });
  run.end({ output: res.choices[0].message.content });
});
await ov.flush();`;
  if (lang === "py")
    return `pip install overturn

export OVERTURN_API_KEY=${k}
export OVERTURN_BASE_URL=${apiUrl}

from overturn import Overturn
from openai import OpenAI

ov = Overturn()                                   # reads the two env vars
client = ov.wrap_openai(OpenAI())                 # every model call is recorded

with ov.run(agent="my-agent", input=ticket) as run:
    res = client.chat.completions.create(model=model, messages=messages)
    run.end(output=res.choices[0].message.content)
ov.flush()`;
  return `# Any OTLP/HTTP exporter (OpenLLMetry, Traceloop, the OpenAI/Anthropic
# instrumentations, LangSmith's OTel export). Spans with gen_ai.* attributes
# become model steps; tool spans with results become recordings.
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${apiUrl}/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${k}"`;
}

export function Onboarding() {
  const qc = useQueryClient();
  const [lang, setLang] = useState<Lang>("ts");
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [apiUrl, setApiUrl] = useState("https://api.overturn.run");
  useEffect(() => {
    getApiUrl().then(setApiUrl);
  }, []);
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: client.keys.list });
  const createKey = useMutation({
    mutationFn: () => client.keys.create("first-agent"),
    onSuccess: (k) => {
      setKey(k.key);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  // the panel stays until the first run lands; poll quietly
  const poll = useQuery({
    queryKey: ["onboarding-poll"],
    queryFn: () => client.runs.list({ limit: 1 }),
    refetchInterval: 3000,
    select: (p) => p.items.length,
  });
  useEffect(() => {
    if (poll.data) qc.invalidateQueries({ queryKey: ["runs"] });
  }, [poll.data, qc]);
  const code = snippet(lang, key, apiUrl);
  const hasKeys = (keys.data?.filter((k) => !k.revokedAt).length ?? 0) > 0;

  return (
    <div className="rounded-md border bg-card" data-testid="onboarding">
      <div className="border-b px-5 py-4">
        <h2 className="text-base font-medium">Record your first run</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Three steps. Once a run arrives this page becomes your run list. Corrections you make on it become
          replayable cases.
        </p>
      </div>
      <div className="grid gap-0 md:grid-cols-[260px_1fr]">
        <ol className="space-y-5 border-b p-5 text-sm md:border-b-0 md:border-r">
          <li>
            <div className="font-medium">1. Create an API key</div>
            {key ? (
              <div className="mt-2">
                <code
                  className="block break-all rounded border bg-background p-2 text-xs"
                  data-testid="onboarding-key"
                >
                  {key}
                </code>
                <p className="mt-1 text-xs text-muted-foreground">
                  Shown once. It is already in the snippet.
                </p>
              </div>
            ) : (
              <div className="mt-2">
                <Button
                  size="sm"
                  onClick={() => createKey.mutate()}
                  disabled={createKey.isPending}
                  data-testid="onboarding-create-key"
                >
                  Create key
                </Button>
                {hasKeys && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    You already have a key; create another or paste yours into the snippet.
                  </p>
                )}
              </div>
            )}
          </li>
          <li>
            <div className="font-medium">2. Wrap your model client</div>
            <p className="mt-1 text-muted-foreground">
              One line around the OpenAI, Anthropic or Vercel AI SDK client you already have. Tools are
              recorded with <code className="text-xs">ov.tool()</code>.
            </p>
          </li>
          <li>
            <div className="font-medium">3. Run your agent once</div>
            <p className="mt-1 flex items-center gap-2 text-muted-foreground">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-warning" />
              Waiting for the first run…
            </p>
          </li>
          <li className="text-xs text-muted-foreground">
            No agent handy?{" "}
            <a
              className="underline"
              href="https://docs.overturn.run/quickstart/"
              target="_blank"
              rel="noreferrer"
            >
              Run the example agent
            </a>{" "}
            — 30 tickets, 20 corrections, one replay, ten minutes.
          </li>
        </ol>
        <div className="min-w-0 p-5">
          <div className="mb-2 flex items-center gap-1">
            {(
              [
                ["ts", "TypeScript"],
                ["py", "Python"],
                ["otel", "OpenTelemetry"],
              ] as Array<[Lang, string]>
            ).map(([l, label]) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={cn(
                  "h-7 rounded-[4px] px-2.5 text-xs font-medium",
                  lang === l ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={async () => {
                await navigator.clipboard.writeText(code).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="max-w-full overflow-auto rounded-md border bg-background p-3 text-xs leading-5">
            {code}
          </pre>
        </div>
      </div>
    </div>
  );
}
