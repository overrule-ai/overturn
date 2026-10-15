import { estimateCostUsd, type Usage } from "@overturn/shared";
import { currentRun } from "./context.js";
import type { Run } from "./run.js";

/**
 * Structural types for the parts of the OpenAI client we touch, so `openai`
 * stays an optional peer dependency.
 */
/** `(...args: never[]) => unknown` accepts any overloaded create() signature. */
export interface OpenAILike {
  chat: { completions: { create: (...args: never[]) => unknown } };
  responses?: { create: (...args: never[]) => unknown };
}
type LooseCreate = (params: Record<string, unknown>, options?: unknown) => Promise<unknown> | unknown;

interface ChatChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

interface ChatCompletionLike {
  id?: string;
  model?: string;
  choices?: Array<{ index?: number; message?: unknown; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

export interface ModelCallHooks {
  /** Replay: substitute the model call entirely. Returns the completion to use. */
  intercept?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
}

const INPUT_KEYS = new Set([
  "messages",
  "tools",
  "tool_choice",
  "response_format",
  "functions",
  "function_call",
]);
const SKIP_PARAM_KEYS = new Set(["model", "stream", "stream_options", ...INPUT_KEYS]);

export function splitChatParams(params: Record<string, unknown>): {
  input: Record<string, unknown>;
  params: Record<string, unknown>;
  model: string | null;
} {
  const input: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (INPUT_KEYS.has(k)) input[k] = v;
    else if (!SKIP_PARAM_KEYS.has(k)) rest[k] = v;
  }
  return { input, params: rest, model: typeof params.model === "string" ? params.model : null };
}

function usageFromOpenAI(u: ChatCompletionLike["usage"]): Usage | undefined {
  if (!u) return undefined;
  const out: Usage = {};
  if (u.prompt_tokens !== undefined) out.inputTokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.outputTokens = u.completion_tokens;
  if (u.total_tokens !== undefined) out.totalTokens = u.total_tokens;
  if (u.prompt_tokens_details?.cached_tokens !== undefined)
    out.cachedInputTokens = u.prompt_tokens_details.cached_tokens;
  return out;
}

/** Rebuilds the final assistant message from streamed chunks. */
export function assembleChatStream(chunks: ChatChunk[]): ChatCompletionLike {
  const content: string[] = [];
  const toolCalls = new Map<
    number,
    { id?: string; type: string; function: { name: string; arguments: string } }
  >();
  let finish: string | null = null;
  let usage: ChatChunk["usage"] = null;
  let id: string | undefined;
  let model: string | undefined;
  let role = "assistant";
  for (const c of chunks) {
    id ??= c.id;
    model ??= c.model;
    if (c.usage) usage = c.usage;
    const choice = c.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta;
    if (!d) continue;
    if (d.role) role = d.role;
    if (d.content) content.push(d.content);
    for (const tc of d.tool_calls ?? []) {
      const cur = toolCalls.get(tc.index) ?? {
        id: tc.id,
        type: tc.type ?? "function",
        function: { name: "", arguments: "" },
      };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      toolCalls.set(tc.index, cur);
    }
  }
  const message: Record<string, unknown> = { role, content: content.length ? content.join("") : null };
  if (toolCalls.size > 0)
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { id, model, choices: [{ index: 0, message, finish_reason: finish }], usage };
}

/**
 * Wraps an OpenAI client so every chat.completions.create (and responses.create)
 * is recorded as an llm_call step on the ambient run. Streaming responses are
 * buffered and recorded as the final message; firstTokenMs is kept in usage.
 */
export function wrapOpenAI<T extends OpenAILike>(client: T, hooks: ModelCallHooks = {}): T {
  const completions = client.chat.completions as { create: LooseCreate };
  const originalCreate: LooseCreate = completions.create.bind(completions);

  const recordedCreate = async (params: Record<string, unknown>, options?: unknown): Promise<unknown> => {
    const run = currentRun();
    if (!run && !hooks.intercept) return originalCreate(params, options);
    const startedAt = new Date();
    const { input, params: p, model } = splitChatParams(params);

    if (hooks.intercept) {
      const out = await hooks.intercept(params);
      recordChat(run, "chat.completions", model, input, p, out as ChatCompletionLike, startedAt, undefined);
      return out;
    }

    const isStream = params.stream === true;
    try {
      const result = await originalCreate(
        isStream
          ? { ...params, stream_options: { include_usage: true, ...(params.stream_options as object) } }
          : params,
        options,
      );
      if (!isStream) {
        recordChat(
          run,
          "chat.completions",
          model,
          input,
          p,
          result as ChatCompletionLike,
          startedAt,
          undefined,
        );
        return result;
      }
      return tapStream(result as AsyncIterable<ChatChunk>, (chunks, firstTokenMs) => {
        recordChat(
          run,
          "chat.completions",
          model,
          input,
          p,
          assembleChatStream(chunks),
          startedAt,
          firstTokenMs,
        );
      });
    } catch (err) {
      run?.step({
        kind: "llm_call",
        name: "chat.completions",
        provider: "openai",
        model,
        input,
        params: p,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt.getTime(),
        startedAt,
      });
      throw err;
    }
  };

  // Mutate in place: OpenAI resources are plain class instances, and callers hold `client`.
  (completions as { create: unknown }).create = recordedCreate;

  if (client.responses) {
    const responses = client.responses as { create: LooseCreate };
    const originalResponses: LooseCreate = responses.create.bind(responses);
    (responses as { create: unknown }).create = async (
      params: Record<string, unknown>,
      options?: unknown,
    ) => {
      const run = currentRun();
      if (!run) return originalResponses(params, options);
      const startedAt = new Date();
      const model = typeof params.model === "string" ? params.model : null;
      const { input: _i, instructions, tools, tool_choice, text, ...rest } = params;
      const input = { input: params.input, instructions, tools, tool_choice, text };
      const { model: _m, ...p } = rest;
      try {
        const result = (await originalResponses(params, options)) as {
          output?: unknown;
          output_text?: string;
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
        };
        const usage: Usage | undefined = result.usage
          ? {
              inputTokens: result.usage.input_tokens,
              outputTokens: result.usage.output_tokens,
              totalTokens: result.usage.total_tokens,
            }
          : undefined;
        run.step({
          kind: "llm_call",
          name: "responses",
          provider: "openai",
          model,
          input,
          params: p,
          output: { output: result.output, output_text: result.output_text },
          usage,
          costUsd: estimateCostUsd(model, usage),
          latencyMs: Date.now() - startedAt.getTime(),
          startedAt,
        });
        return result;
      } catch (err) {
        run.step({
          kind: "llm_call",
          name: "responses",
          provider: "openai",
          model,
          input,
          params: p,
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startedAt.getTime(),
          startedAt,
        });
        throw err;
      }
    };
  }
  return client;
}

function recordChat(
  run: Run | undefined,
  name: string,
  model: string | null,
  input: Record<string, unknown>,
  params: Record<string, unknown>,
  result: ChatCompletionLike,
  startedAt: Date,
  firstTokenMs: number | undefined,
): void {
  if (!run) return;
  const usage = usageFromOpenAI(result.usage);
  if (usage && firstTokenMs !== undefined) usage.firstTokenMs = firstTokenMs;
  const choice = result.choices?.[0];
  run.step({
    kind: "llm_call",
    name,
    provider: "openai",
    model: result.model ?? model,
    input,
    params,
    output: choice ? { message: choice.message, finish_reason: choice.finish_reason ?? null } : null,
    usage,
    costUsd: estimateCostUsd(result.model ?? model, usage),
    latencyMs: Date.now() - startedAt.getTime(),
    startedAt,
  });
}

/** Passes a stream through untouched while collecting chunks; calls onDone when it ends. */
function tapStream<C>(
  stream: AsyncIterable<C>,
  onDone: (chunks: C[], firstTokenMs: number) => void,
): AsyncIterable<C> {
  const chunks: C[] = [];
  const start = Date.now();
  let firstTokenMs = -1;
  const original = stream as AsyncIterable<C> & Record<string, unknown>;
  const iterable: AsyncIterable<C> = {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of original) {
          if (firstTokenMs < 0) firstTokenMs = Date.now() - start;
          chunks.push(chunk);
          yield chunk;
        }
      } finally {
        onDone(chunks, Math.max(firstTokenMs, 0));
      }
    },
  };
  // keep helper methods like .controller / .toReadableStream reachable
  return new Proxy(iterable, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) return Reflect.get(target, prop, receiver);
      const v = original[prop as string];
      return typeof v === "function" ? v.bind(original) : v;
    },
  });
}
