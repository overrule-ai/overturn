/**
 * Maps OTLP traces using the OpenTelemetry GenAI semantic conventions to
 * Overturn runs and steps. One trace = one run; LLM and tool spans = steps.
 *
 * Recognised attributes (any of these conventions may appear):
 *   LLM call:  gen_ai.operation.name (chat|text_completion|generate_content|embeddings),
 *              gen_ai.request.model, gen_ai.response.model, gen_ai.system / gen_ai.provider.name,
 *              gen_ai.usage.input_tokens / output_tokens, gen_ai.request.* params,
 *              messages in gen_ai.input.messages / gen_ai.output.messages (JSON),
 *              gen_ai.prompt / gen_ai.completion (JSON), gen_ai.prompt.N.{role,content} (OpenLLMetry),
 *              or events gen_ai.content.prompt / gen_ai.content.completion.
 *   Tool call: gen_ai.operation.name = execute_tool, gen_ai.tool.name,
 *              gen_ai.tool.call.arguments / gen_ai.tool.call.result (JSON),
 *              or traceloop.entity.input / traceloop.entity.output.
 *   Run:       root span. gen_ai.agent.name | overturn.agent | service.name; overturn.agent.version |
 *              service.version; overturn.tags (string[]); overturn.input / overturn.output (JSON);
 *              overturn.external_id. Span status ERROR marks the run failed.
 *   Side effects: overturn.side_effect (bool) on tool spans.
 */
import { createHash } from "node:crypto";
import { type RunUpsert, type StepUpsert, toolFingerprint } from "@overturn-ai/shared";

// ---------- OTLP JSON shapes (subset) ----------

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: string;
}
export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}
export interface OtlpEvent {
  timeUnixNano?: string | number;
  name?: string;
  attributes?: OtlpKeyValue[];
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: string | number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  events?: OtlpEvent[];
  status?: { code?: string | number; message?: string };
}
export interface OtlpExportTraceServiceRequest {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpKeyValue[] };
    scopeSpans?: Array<{ scope?: { name?: string }; spans?: OtlpSpan[] }>;
  }>;
}

// ---------- helpers ----------

export function anyValueToJs(v: OtlpAnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValueToJs);
  if (v.kvlistValue) return attrsToObject(v.kvlistValue.values ?? []);
  if (v.bytesValue !== undefined) return v.bytesValue;
  return null;
}

export function attrsToObject(attrs: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of attrs ?? []) out[kv.key] = anyValueToJs(kv.value);
  return out;
}

/** OTLP/JSON carries ids as hex; protobuf-decoded objects carry base64. Normalize to lowercase hex. */
export function idToHex(id: string | undefined, bytes: number): string {
  if (!id) return "";
  const isHex = /^[0-9a-fA-F]+$/.test(id) && id.length === bytes * 2;
  return (isHex ? id : Buffer.from(id, "base64").toString("hex")).toLowerCase().padStart(bytes * 2, "0");
}

export function traceIdToUuid(traceHex: string): string {
  // 32 hex chars -> UUID shape; set version nibble to 8 (custom) so it is a valid UUID string.
  const h = traceHex.padStart(32, "0").slice(0, 32);
  const v = `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variantNibble(h[16]!)}${h.slice(17, 20)}-${h.slice(20)}`;
  return v;
}

function variantNibble(c: string): string {
  const n = Number.parseInt(c, 16);
  return ((n & 0x3) | 0x8).toString(16);
}

export function spanIdToUuid(traceHex: string, spanHex: string): string {
  const h = createHash("sha256").update(`${traceHex}:${spanHex}`).digest("hex").slice(0, 32);
  return traceIdToUuid(h);
}

function nanosToDate(n: string | number | undefined): Date | null {
  if (n === undefined || n === null || n === "" || n === 0) return null;
  const big = typeof n === "string" ? BigInt(n) : BigInt(Math.trunc(n));
  return new Date(Number(big / 1_000_000n));
}

function parseJsonMaybe(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------- classification ----------

type SpanClass = "llm_call" | "tool_call" | "retrieval" | null;

const LLM_OPS = new Set(["chat", "text_completion", "generate_content", "embeddings", "completion"]);

export function classifySpan(attrs: Record<string, unknown>): SpanClass {
  const op =
    typeof attrs["gen_ai.operation.name"] === "string" ? (attrs["gen_ai.operation.name"] as string) : null;
  if (op === "execute_tool" || attrs["gen_ai.tool.name"] !== undefined) return "tool_call";
  if (op === "retrieve" || op === "retrieval" || attrs["db.system"] === "vector") return "retrieval";
  if (
    (op && LLM_OPS.has(op)) ||
    attrs["gen_ai.request.model"] !== undefined ||
    attrs["llm.request.model"] !== undefined
  )
    return "llm_call";
  if (attrs["traceloop.span.kind"] === "tool") return "tool_call";
  if (attrs["openinference.span.kind"] === "LLM") return "llm_call";
  if (attrs["openinference.span.kind"] === "TOOL") return "tool_call";
  return null;
}

function openLlmetryMessages(
  attrs: Record<string, unknown>,
  prefix: "gen_ai.prompt" | "gen_ai.completion",
): unknown[] | null {
  const msgs: Array<{ role: unknown; content: unknown }> = [];
  for (let i = 0; i < 100; i++) {
    const role = attrs[`${prefix}.${i}.role`];
    const content = attrs[`${prefix}.${i}.content`];
    if (role === undefined && content === undefined) break;
    msgs.push({ role, content: parseJsonMaybe(content) });
  }
  return msgs.length ? msgs : null;
}

function llmInput(attrs: Record<string, unknown>, events: OtlpEvent[]): Record<string, unknown> {
  const messages =
    parseJsonMaybe(attrs["gen_ai.input.messages"]) ??
    parseJsonMaybe(attrs["gen_ai.prompt"]) ??
    openLlmetryMessages(attrs, "gen_ai.prompt") ??
    parseJsonMaybe(attrs["llm.input_messages"]) ??
    eventPayload(events, "gen_ai.content.prompt", "gen_ai.prompt") ??
    null;
  const tools = parseJsonMaybe(attrs["gen_ai.request.tools"] ?? attrs["llm.tools"]) ?? null;
  const out: Record<string, unknown> = { messages };
  if (tools !== null) out.tools = tools;
  const systemInstructions = parseJsonMaybe(attrs["gen_ai.system_instructions"]);
  if (systemInstructions !== undefined && systemInstructions !== null) out.system = systemInstructions;
  return out;
}

function llmOutput(attrs: Record<string, unknown>, events: OtlpEvent[]): unknown {
  const out =
    parseJsonMaybe(attrs["gen_ai.output.messages"]) ??
    parseJsonMaybe(attrs["gen_ai.completion"]) ??
    openLlmetryMessages(attrs, "gen_ai.completion") ??
    parseJsonMaybe(attrs["llm.output_messages"]) ??
    eventPayload(events, "gen_ai.content.completion", "gen_ai.completion") ??
    null;
  const finish = attrs["gen_ai.response.finish_reasons"];
  if (out === null && finish === undefined) return null;
  return {
    message: Array.isArray(out) && out.length === 1 ? out[0] : out,
    finish_reason: Array.isArray(finish) ? finish[0] : (finish ?? null),
  };
}

function eventPayload(events: OtlpEvent[], eventName: string, attrKey: string): unknown {
  const ev = events.find((e) => e.name === eventName);
  if (!ev) return undefined;
  const a = attrsToObject(ev.attributes);
  return parseJsonMaybe(a[attrKey] ?? a.content ?? a.body) ?? null;
}

function requestParams(attrs: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const m = /^gen_ai\.request\.(.+)$/.exec(k);
    if (m && m[1] !== "model" && m[1] !== "tools") params[m[1]!] = v;
  }
  return params;
}

// ---------- mapping ----------

export interface MappedTrace {
  runs: RunUpsert[];
  steps: StepUpsert[];
}

export function mapOtlpTraces(req: OtlpExportTraceServiceRequest): MappedTrace {
  const byTrace = new Map<string, Array<{ span: OtlpSpan; resource: Record<string, unknown> }>>();
  for (const rs of req.resourceSpans ?? []) {
    const resource = attrsToObject(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const traceHex = idToHex(span.traceId, 16);
        if (!traceHex) continue;
        const list = byTrace.get(traceHex) ?? [];
        list.push({ span, resource });
        byTrace.set(traceHex, list);
      }
    }
  }

  const runs: RunUpsert[] = [];
  const steps: StepUpsert[] = [];

  for (const [traceHex, entries] of byTrace) {
    const runId = traceIdToUuid(traceHex);
    const spans = entries.map((e) => ({
      ...e,
      spanHex: idToHex(e.span.spanId, 8),
      parentHex: idToHex(e.span.parentSpanId, 8),
      attrs: attrsToObject(e.span.attributes),
      start: nanosToDate(e.span.startTimeUnixNano),
      end: nanosToDate(e.span.endTimeUnixNano),
    }));
    const ids = new Set(spans.map((s) => s.spanHex));
    spans.sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));

    // Root: no parent, or parent not in this batch (partial export) -> treat the earliest such span as root.
    const root = spans.find((s) => !s.parentHex) ?? spans.find((s) => !ids.has(s.parentHex)) ?? spans[0]!;
    const rootAttrs = root.attrs;
    const resource = root.resource;
    const agent =
      str(rootAttrs["gen_ai.agent.name"]) ??
      str(rootAttrs["overturn.agent"]) ??
      str(resource["service.name"]) ??
      root.span.name ??
      "otel";
    const hasRoot = !root.parentHex;
    const status = root.span.status?.code;
    const errored = status === "STATUS_CODE_ERROR" || status === 2;
    const ended = hasRoot && root.end;
    const tags = Array.isArray(rootAttrs["overturn.tags"])
      ? (rootAttrs["overturn.tags"] as unknown[]).map(String)
      : [];

    // A batch without the trace's root (exporters send spans as they end) must not guess run
    // fields: ingest creates a stub run for the steps and the root's batch fills it in later.
    if (hasRoot) {
      runs.push({
        id: runId,
        agent,
        agentVersion:
          str(rootAttrs["overturn.agent.version"]) ??
          str(rootAttrs["gen_ai.agent.version"]) ??
          str(resource["service.version"]) ??
          null,
        externalId: str(rootAttrs["overturn.external_id"]) ?? null,
        status: ended ? (errored ? "failed" : "completed") : "running",
        input: parseJsonMaybe(
          rootAttrs["overturn.input"] ?? rootAttrs["traceloop.entity.input"] ?? rootAttrs["input.value"],
        ),
        output: parseJsonMaybe(
          rootAttrs["overturn.output"] ?? rootAttrs["traceloop.entity.output"] ?? rootAttrs["output.value"],
        ),
        metadata: {
          source: "otlp",
          traceId: traceHex,
          rootSpan: root.span.name ?? null,
          service: str(resource["service.name"]) ?? null,
        },
        tags: tags.length ? [...tags, "otel"] : ["otel"],
        startedAt: (root.start ?? spans[0]!.start ?? new Date()).toISOString(),
        endedAt: ended ? root.end!.toISOString() : null,
        error: errored ? (root.span.status?.message ?? "error") : null,
      });
    }

    // Steps: parent step = nearest ancestor that is itself a step.
    const stepIdBySpan = new Map<string, string>();
    const parentOf = new Map(spans.map((s) => [s.spanHex, s.parentHex] as const));
    // Spans that start in the same microsecond get consecutive seqs in nanosecond order,
    // so a parent and the child it immediately opened keep their order in the timeline.
    const seqOf = new Map<string, number>();
    const byStart = [...spans].sort((x, y) =>
      BigInt(x.span.startTimeUnixNano ?? 0) < BigInt(y.span.startTimeUnixNano ?? 0) ? -1 : 1,
    );
    let lastMicros = -1;
    let tie = 0;
    for (const s of byStart) {
      const micros = s.span.startTimeUnixNano ? Number(BigInt(s.span.startTimeUnixNano) / 1000n) : 0;
      tie = micros === lastMicros ? tie + 1 : 0;
      lastMicros = micros;
      seqOf.set(s.spanHex, micros + tie);
    }
    for (const s of spans) {
      const kind = classifySpan(s.attrs);
      if (!kind) continue;
      const stepId = spanIdToUuid(traceHex, s.spanHex);
      stepIdBySpan.set(s.spanHex, stepId);
      let p = s.parentHex;
      let parentStepId: string | null = null;
      while (p) {
        const sid = stepIdBySpan.get(p);
        if (sid) {
          parentStepId = sid;
          break;
        }
        p = parentOf.get(p) ?? "";
      }
      const a = s.attrs;
      const events = s.span.events ?? [];
      const latencyMs = s.start && s.end ? s.end.getTime() - s.start.getTime() : null;
      const errorMsg =
        s.span.status?.code === "STATUS_CODE_ERROR" || s.span.status?.code === 2
          ? (s.span.status?.message ?? "error")
          : null;
      const base = {
        id: stepId,
        runId,
        parentStepId,
        // microseconds since epoch (+ tie-break): stable across batches, so spans exported separately still order correctly
        seq: seqOf.get(s.spanHex) ?? 0,
        startedAt: (s.start ?? new Date()).toISOString(),
        endedAt: s.end?.toISOString() ?? null,
        latencyMs,
        error: errorMsg,
      };
      if (kind === "llm_call") {
        const model =
          str(a["gen_ai.response.model"]) ??
          str(a["gen_ai.request.model"]) ??
          str(a["llm.request.model"]) ??
          null;
        const inputTokens = num(
          a["gen_ai.usage.input_tokens"] ?? a["gen_ai.usage.prompt_tokens"] ?? a["llm.usage.prompt_tokens"],
        );
        const outputTokens = num(
          a["gen_ai.usage.output_tokens"] ??
            a["gen_ai.usage.completion_tokens"] ??
            a["llm.usage.completion_tokens"],
        );
        steps.push({
          ...base,
          kind: "llm_call",
          name: str(a["gen_ai.operation.name"]) ?? s.span.name ?? "llm",
          provider: str(a["gen_ai.provider.name"]) ?? str(a["gen_ai.system"]) ?? null,
          model,
          input: llmInput(a, events),
          output: llmOutput(a, events),
          params: requestParams(a),
          usage:
            inputTokens !== undefined || outputTokens !== undefined
              ? { inputTokens, outputTokens }
              : undefined,
          costUsd: num(a["gen_ai.usage.cost"]) ?? null,
        });
      } else if (kind === "tool_call") {
        const name = str(a["gen_ai.tool.name"]) ?? s.span.name ?? "tool";
        const args =
          parseJsonMaybe(
            a["gen_ai.tool.call.arguments"] ??
              a["traceloop.entity.input"] ??
              a["input.value"] ??
              a["gen_ai.tool.input"],
          ) ?? null;
        const result =
          parseJsonMaybe(
            a["gen_ai.tool.call.result"] ??
              a["traceloop.entity.output"] ??
              a["output.value"] ??
              a["gen_ai.tool.output"],
          ) ?? null;
        steps.push({
          ...base,
          kind: "tool_call",
          name,
          input: args,
          output: result,
          sideEffect: a["overturn.side_effect"] === true,
          fingerprint: toolFingerprint(name, args),
        });
      } else {
        steps.push({
          ...base,
          kind: "retrieval",
          name: s.span.name ?? "retrieval",
          input:
            parseJsonMaybe(a["db.query.text"] ?? a["input.value"] ?? a["traceloop.entity.input"]) ?? null,
          output: parseJsonMaybe(a["output.value"] ?? a["traceloop.entity.output"]) ?? null,
        });
      }
    }
  }
  return { runs, steps };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
