import { estimateCostUsd, type Usage } from "@overturn/shared";
import { currentRun } from "./context.js";
import type { Run } from "./run.js";

/** Structural type so `@anthropic-ai/sdk` stays an optional peer dependency. */
export interface AnthropicLike {
  messages: { create: (...args: never[]) => unknown };
}
type LooseCreate = (params: Record<string, unknown>, options?: unknown) => Promise<unknown> | unknown;

interface MessageLike {
  id?: string;
  model?: string;
  role?: string;
  content?: unknown[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | null;
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: MessageLike;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

const INPUT_KEYS = new Set(["messages", "system", "tools", "tool_choice"]);
const SKIP = new Set(["model", "stream", ...INPUT_KEYS]);

export function splitMessageParams(params: Record<string, unknown>): {
  input: Record<string, unknown>;
  params: Record<string, unknown>;
  model: string | null;
} {
  const input: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (INPUT_KEYS.has(k)) input[k] = v;
    else if (!SKIP.has(k)) rest[k] = v;
  }
  return { input, params: rest, model: typeof params.model === "string" ? params.model : null };
}

function usageFrom(m: MessageLike): Usage | undefined {
  const u = m.usage;
  if (!u) return undefined;
  const out: Usage = {};
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (out.inputTokens !== undefined || out.outputTokens !== undefined)
    out.totalTokens = (out.inputTokens ?? 0) + (out.outputTokens ?? 0);
  if (u.cache_read_input_tokens !== undefined) out.cachedInputTokens = u.cache_read_input_tokens;
  return out;
}

/** Rebuilds a Message from raw stream events. */
export function assembleMessageStream(events: StreamEvent[]): MessageLike {
  const blocks = new Map<number, Record<string, unknown>>();
  const jsonParts = new Map<number, string[]>();
  const msg: MessageLike = { role: "assistant", content: [], stop_reason: null, usage: {} };
  const usage: Record<string, unknown> = {};
  for (const e of events) {
    if (e.type === "message_start" && e.message) {
      msg.id = e.message.id;
      msg.model = e.message.model;
      Object.assign(usage, e.message.usage ?? {});
    } else if (e.type === "content_block_start" && e.index !== undefined) {
      const block = { ...(e.content_block ?? {}) };
      if (block.type === "tool_use") {
        jsonParts.set(e.index, []);
        block.input = {};
      } else if (block.type === "text") block.text = block.text ?? "";
      blocks.set(e.index, block);
    } else if (e.type === "content_block_delta" && e.index !== undefined) {
      const block = blocks.get(e.index) ?? {};
      blocks.set(e.index, block);
      const d = e.delta ?? {};
      if (d.type === "text_delta") block.text = `${(block.text as string) ?? ""}${(d.text as string) ?? ""}`;
      else if (d.type === "input_json_delta")
        (jsonParts.get(e.index) ?? jsonParts.set(e.index, []).get(e.index))!.push(
          (d.partial_json as string) ?? "",
        );
    } else if (e.type === "message_delta") {
      if (e.delta?.stop_reason) msg.stop_reason = e.delta.stop_reason as string;
      for (const [k, v] of Object.entries(e.usage ?? {})) if (v !== null && v !== undefined) usage[k] = v;
    }
  }
  for (const [idx, parts] of jsonParts) {
    const raw = parts.join("");
    const block = blocks.get(idx);
    if (!block) continue;
    try {
      block.input = raw ? JSON.parse(raw) : {};
    } catch {
      block.input = { _raw: raw };
    }
  }
  msg.content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  msg.usage = usage as MessageLike["usage"];
  return msg;
}

function record(
  run: Run | undefined,
  model: string | null,
  input: Record<string, unknown>,
  params: Record<string, unknown>,
  message: MessageLike | null,
  startedAt: Date,
  firstTokenMs?: number,
  error?: string,
): void {
  if (!run) return;
  const usage = message ? usageFrom(message) : undefined;
  if (usage && firstTokenMs !== undefined) usage.firstTokenMs = firstTokenMs;
  const resolved = message?.model ?? model;
  run.step({
    kind: "llm_call",
    name: "messages",
    provider: "anthropic",
    model: resolved,
    input,
    params,
    output: message
      ? {
          message: { role: message.role ?? "assistant", content: message.content },
          finish_reason: message.stop_reason ?? null,
        }
      : null,
    usage,
    costUsd: estimateCostUsd(resolved, usage),
    latencyMs: Date.now() - startedAt.getTime(),
    error: error ?? null,
    startedAt,
  });
}

/** Wraps an Anthropic client so messages.create (streaming or not) is recorded as an llm_call step. */
export function wrapAnthropic<T extends AnthropicLike>(client: T): T {
  const messages = client.messages as { create: LooseCreate };
  const original: LooseCreate = messages.create.bind(messages);
  messages.create = async (params: Record<string, unknown>, options?: unknown) => {
    const run = currentRun();
    if (!run) return original(params, options);
    const startedAt = new Date();
    const { input, params: p, model } = splitMessageParams(params);
    let result: unknown;
    try {
      result = await original(params, options);
    } catch (err) {
      record(
        run,
        model,
        input,
        p,
        null,
        startedAt,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
    if (params.stream !== true) {
      record(run, model, input, p, result as MessageLike, startedAt);
      return result;
    }
    const stream = result as AsyncIterable<StreamEvent> & Record<string, unknown>;
    const events: StreamEvent[] = [];
    const t0 = Date.now();
    let first = -1;
    const tapped: AsyncIterable<StreamEvent> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const ev of stream) {
            if (first < 0) first = Date.now() - t0;
            events.push(ev);
            yield ev;
          }
        } finally {
          record(run, model, input, p, assembleMessageStream(events), startedAt, Math.max(first, 0));
        }
      },
    };
    return new Proxy(tapped, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncIterator) return Reflect.get(target, prop, receiver);
        const v = stream[prop as string];
        return typeof v === "function" ? v.bind(stream) : v;
      },
    });
  };
  return client;
}
