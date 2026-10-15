/**
 * Turns a case's frozen llm_call input (OpenAI chat, Anthropic messages, AI SDK prompt
 * or OTLP gen_ai messages) into one Vercel AI SDK generateText call against a target
 * model, and extracts the answer in the shape humans correct.
 */
import { extractAnswer, type FrozenInput, parseJsonText } from "@overturn-ai/shared";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  type ToolSet,
  tool,
} from "ai";

export interface ModelCallResultFull extends ModelCallResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
}

export interface ModelCallResult {
  answer: unknown;
  raw: unknown;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason: string;
  modelId: string | null;
}

type Msg = Record<string, unknown>;

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : typeof p === "object" && p && typeof (p as Msg).text === "string"
            ? ((p as Msg).text as string)
            : "",
      )
      .join("");
  return content === null || content === undefined ? "" : JSON.stringify(content);
}

/** OpenAI chat messages (and simple {role, content} lists) -> AI SDK ModelMessage[]. */
export function fromChatMessages(messages: Msg[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const role = m.role as string;
    if (role === "system" || role === "developer") out.push({ role: "system", content: asText(m.content) });
    else if (role === "user") out.push({ role: "user", content: asText(m.content) });
    else if (role === "assistant") {
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      const text = asText(m.content);
      if (text) parts.push({ type: "text", text });
      for (const tc of (m.tool_calls as Msg[] | undefined) ?? []) {
        const fn = (tc.function ?? {}) as Msg;
        parts.push({
          type: "tool-call",
          toolCallId: String(tc.id ?? fn.name),
          toolName: String(fn.name),
          input: parseJsonText(fn.arguments) ?? {},
        });
      }
      out.push({ role: "assistant", content: parts.length ? parts : "" });
    } else if (role === "tool") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: String(m.tool_call_id ?? m.name ?? "call"),
            toolName: String(m.name ?? "tool"),
            output: { type: "json", value: parseJsonText(m.content) as never },
          },
        ],
      });
    }
  }
  return out;
}

/** Anthropic messages (content blocks) + system -> ModelMessage[]. */
export function fromAnthropicMessages(system: unknown, messages: Msg[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  if (system) out.push({ role: "system", content: asText(system) });
  for (const m of messages) {
    const blocks = Array.isArray(m.content)
      ? (m.content as Msg[])
      : [{ type: "text", text: asText(m.content) }];
    if (m.role === "user") {
      const results = blocks.filter((b) => b.type === "tool_result");
      if (results.length) {
        out.push({
          role: "tool",
          content: results.map((b) => ({
            type: "tool-result" as const,
            toolCallId: String(b.tool_use_id),
            toolName: "tool",
            output: { type: "json" as const, value: parseJsonText(asText(b.content)) as never },
          })),
        });
      }
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      if (text || !results.length) out.push({ role: "user", content: text });
    } else {
      const parts = blocks.map((b) =>
        b.type === "tool_use"
          ? {
              type: "tool-call" as const,
              toolCallId: String(b.id),
              toolName: String(b.name),
              input: b.input ?? {},
            }
          : { type: "text" as const, text: String(b.text ?? "") },
      );
      out.push({ role: "assistant", content: parts });
    }
  }
  return out;
}

/** AI SDK prompts are already ModelMessage-shaped (content as string or parts); normalize tool results. */
export function fromAiMessages(messages: Msg[]): ModelMessage[] {
  return messages.map((m) => {
    const role = m.role as string;
    if (role === "system") return { role: "system", content: asText(m.content) };
    if (role === "user")
      return typeof m.content === "string"
        ? { role: "user", content: m.content }
        : { role: "user", content: asText(m.content) };
    if (role === "tool") return m as unknown as ModelMessage;
    return m as unknown as ModelMessage;
  });
}

function toolsFrom(frozen: FrozenInput): ToolSet | undefined {
  const raw = frozen.tools;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const t of raw as Msg[]) {
    // OpenAI: {type:'function', function:{name, description, parameters}}; Anthropic: {name, description, input_schema}
    const fn = (t.function as Msg | undefined) ?? t;
    const name = String(fn.name ?? "");
    if (!name) continue;
    const schema = (fn.parameters ??
      fn.input_schema ??
      fn.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
    tools[name] = tool({
      description: typeof fn.description === "string" ? fn.description : undefined,
      inputSchema: jsonSchema(schema as never),
    });
  }
  return Object.keys(tools).length ? tools : undefined;
}

export interface BuildOptions {
  /** Replace the system prompt (prompt-version targeting). */
  systemPrompt?: string | null;
}

export function buildMessages(frozen: FrozenInput, opts: BuildOptions = {}): ModelMessage[] {
  let messages: ModelMessage[];
  const msgs = Array.isArray(frozen.messages) ? (frozen.messages as Msg[]) : [];
  if (frozen.provider === "anthropic" || frozen.system !== undefined)
    messages = fromAnthropicMessages(frozen.system, msgs);
  else messages = fromChatMessages(msgs);
  if (opts.systemPrompt) {
    const i = messages.findIndex((m) => m.role === "system");
    if (i >= 0) messages[i] = { role: "system", content: opts.systemPrompt };
    else messages.unshift({ role: "system", content: opts.systemPrompt });
  }
  return messages;
}

function responseFormat(
  frozen: FrozenInput,
): { type: "json_schema"; schema: Record<string, unknown> } | { type: "json" } | null {
  const rf = frozen.response_format as Msg | undefined;
  if (!rf) return null;
  if (rf.type === "json_schema") {
    const js = (rf.json_schema as Msg | undefined) ?? {};
    return { type: "json_schema", schema: (js.schema as Record<string, unknown>) ?? { type: "object" } };
  }
  if (rf.type === "json_object") return { type: "json" };
  return null;
}

export async function callModel(
  model: LanguageModel,
  frozen: FrozenInput,
  opts: BuildOptions = {},
): Promise<ModelCallResultFull> {
  const messages = buildMessages(frozen, opts);
  const params = frozen.params ?? {};
  const tools = toolsFrom(frozen);
  const rf = responseFormat(frozen);
  const maxOutputTokens =
    typeof params.max_tokens === "number"
      ? params.max_tokens
      : typeof params.max_completion_tokens === "number"
        ? params.max_completion_tokens
        : undefined;
  const seed = typeof params.seed === "number" ? params.seed : 42;

  const result = await generateText({
    model,
    messages,
    tools,
    toolChoice: tools ? mapToolChoice(frozen.tool_choice) : undefined,
    temperature: 0,
    seed,
    maxOutputTokens,
    maxRetries: 0,
    ...(rf?.type === "json_schema"
      ? { experimental_output: Output.object({ schema: jsonSchema(rf.schema as never) }) }
      : rf?.type === "json"
        ? {
            experimental_output: Output.object({
              schema: jsonSchema({ type: "object", additionalProperties: true } as never),
            }),
          }
        : {}),
  });

  let answer: unknown;
  if (result.toolCalls.length > 0) {
    answer = { tool_calls: result.toolCalls.map((tc) => ({ name: tc.toolName, args: tc.input })) };
  } else {
    answer = extractAnswer({ message: { role: "assistant", content: result.text } });
  }
  return {
    answer,
    text: result.text,
    toolCalls: result.toolCalls.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, args: tc.input })),
    raw: {
      text: result.text,
      toolCalls: result.toolCalls.map((tc) => ({ name: tc.toolName, args: tc.input })),
      finishReason: result.finishReason,
    },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    finishReason: result.finishReason,
    modelId: result.response.modelId ?? null,
  };
}

function mapToolChoice(
  tc: unknown,
): "auto" | "required" | "none" | { type: "tool"; toolName: string } | undefined {
  if (tc === undefined || tc === null) return undefined;
  if (tc === "auto" || tc === "required" || tc === "none") return tc;
  if (tc === "any") return "required";
  if (typeof tc === "object") {
    const o = tc as Msg;
    const name = ((o.function as Msg | undefined)?.name ?? o.name) as string | undefined;
    if (name) return { type: "tool", toolName: name };
  }
  return undefined;
}
