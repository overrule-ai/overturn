/**
 * Vercel AI SDK (v5) middleware: records every generate/stream call made through
 * `wrapLanguageModel({ model, middleware: ov.aiMiddleware() })` as an llm_call step.
 */

import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { estimateCostUsd, type Usage } from "@overturn/shared";
import { currentRun } from "./context.js";
import { getGlobalReplay } from "./replay.js";

type Params = Parameters<NonNullable<LanguageModelV2Middleware["wrapGenerate"]>>[0]["params"];

function splitParams(params: Params): { input: Record<string, unknown>; rest: Record<string, unknown> } {
  const { prompt, tools, toolChoice, responseFormat, ...rest } = params;
  const input: Record<string, unknown> = { messages: prompt };
  if (tools) input.tools = tools;
  if (toolChoice) input.tool_choice = toolChoice;
  if (responseFormat) input.response_format = responseFormat;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest))
    if (v !== undefined && k !== "providerOptions" && k !== "abortSignal" && k !== "headers") cleaned[k] = v;
  return { input, rest: cleaned };
}

function usageFrom(
  u:
    | { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number }
    | undefined,
): Usage | undefined {
  if (!u) return undefined;
  const out: Usage = {};
  if (u.inputTokens !== undefined) out.inputTokens = u.inputTokens;
  if (u.outputTokens !== undefined) out.outputTokens = u.outputTokens;
  if (u.totalTokens !== undefined) out.totalTokens = u.totalTokens;
  if (u.cachedInputTokens !== undefined) out.cachedInputTokens = u.cachedInputTokens;
  return out;
}

export function aiMiddleware(): LanguageModelV2Middleware {
  return {
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const run = currentRun();
      const replay = getGlobalReplay();
      if (!run && !replay?.modelCall) return doGenerate();
      const startedAt = new Date();
      const { input, rest } = splitParams(params);
      const modelId = `${model.provider}/${model.modelId}`;
      try {
        const result = replay?.modelCall
          ? await replayGenerate(replay.modelCall, params)
          : await doGenerate();
        const usage = usageFrom(result.usage);
        run?.step({
          kind: "llm_call",
          name: "ai.generate",
          provider: model.provider,
          model: result.response?.modelId ?? model.modelId,
          input,
          params: rest,
          output: { content: result.content, finish_reason: result.finishReason },
          usage,
          costUsd: estimateCostUsd(modelId, usage),
          latencyMs: Date.now() - startedAt.getTime(),
          startedAt,
        });
        return result;
      } catch (err) {
        run?.step({
          kind: "llm_call",
          name: "ai.generate",
          provider: model.provider,
          model: model.modelId,
          input,
          params: rest,
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startedAt.getTime(),
          startedAt,
        });
        throw err;
      }
    },
    wrapStream: async ({ doStream, params, model }) => {
      const run = currentRun();
      if (!run) return doStream();
      const startedAt = new Date();
      const { input, rest } = splitParams(params);
      const modelId = `${model.provider}/${model.modelId}`;
      const result = await doStream();
      const text: string[] = [];
      const toolCalls: Array<{ toolCallId: string; toolName: string; input: string }> = [];
      let finishReason: string | undefined;
      let usage: Usage | undefined;
      let responseModel: string | undefined;
      let firstTokenMs = -1;
      const t0 = Date.now();
      const transform = new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
        transform(part, controller) {
          if (firstTokenMs < 0 && (part.type === "text-delta" || part.type === "tool-call"))
            firstTokenMs = Date.now() - t0;
          if (part.type === "text-delta") text.push(part.delta);
          else if (part.type === "tool-call")
            toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
          else if (part.type === "response-metadata") responseModel = part.modelId ?? responseModel;
          else if (part.type === "finish") {
            finishReason = part.finishReason;
            usage = usageFrom(part.usage);
          }
          controller.enqueue(part);
        },
        flush() {
          if (usage && firstTokenMs >= 0) usage.firstTokenMs = firstTokenMs;
          const content: unknown[] = [];
          if (text.length) content.push({ type: "text", text: text.join("") });
          for (const tc of toolCalls) content.push({ type: "tool-call", ...tc });
          run.step({
            kind: "llm_call",
            name: "ai.stream",
            provider: model.provider,
            model: responseModel ?? model.modelId,
            input,
            params: rest,
            output: { content, finish_reason: finishReason ?? null },
            usage,
            costUsd: estimateCostUsd(modelId, usage),
            latencyMs: Date.now() - startedAt.getTime(),
            startedAt,
          });
        },
      });
      return { ...result, stream: result.stream.pipeThrough(transform) };
    },
  };
}

type GenerateResult = Awaited<
  ReturnType<Parameters<NonNullable<LanguageModelV2Middleware["wrapGenerate"]>>[0]["doGenerate"]>
>;

/** Trajectory replay: answer an AI SDK generate call from the target model on the server. */
async function replayGenerate(
  call: NonNullable<ReturnType<typeof getGlobalReplay>>["modelCall"] & {},
  params: Params,
): Promise<GenerateResult> {
  const { input, rest } = splitParams(params);
  const out = await call({
    provider: "ai",
    messages: input.messages,
    tools: input.tools,
    tool_choice: input.tool_choice,
    response_format: input.response_format,
    params: rest,
  });
  const content: GenerateResult["content"] = [];
  if (out.text) content.push({ type: "text", text: out.text });
  for (const tc of out.toolCalls)
    content.push({
      type: "tool-call",
      toolCallId: tc.id,
      toolName: tc.name,
      input: JSON.stringify(tc.args ?? {}),
    });
  return {
    content,
    finishReason: out.toolCalls.length ? "tool-calls" : "stop",
    usage: {
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
      totalTokens: out.usage.totalTokens,
    },
    warnings: [],
    response: { modelId: out.modelId ?? undefined },
  };
}
