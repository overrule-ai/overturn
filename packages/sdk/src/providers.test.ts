import type { IngestPayload } from "@overturn/shared";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { assembleMessageStream } from "./anthropic.js";
import { Overturn } from "./client.js";

function capture() {
  const batches: IngestPayload[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    batches.push(JSON.parse(String(init?.body)) as IngestPayload);
    return new Response("{}", { status: 202 });
  }) as typeof globalThis.fetch;
  const ov = new Overturn({
    apiKey: "ov_live_test",
    baseUrl: "http://x",
    transport: { fetch, disableTimer: true },
  });
  return { ov, steps: () => batches.flatMap((b) => b.steps) };
}

type FakeAnthropic = {
  messages: { create: (params: Record<string, unknown>) => Promise<unknown> };
};
function fakeAnthropic(): FakeAnthropic {
  return {
    messages: {
      async create(params: Record<string, unknown>) {
        if (params.stream) {
          const events = [
            {
              type: "message_start",
              message: {
                id: "msg_1",
                model: "claude-haiku-4-5",
                role: "assistant",
                usage: { input_tokens: 7, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
            {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "tu_1", name: "set_pri", input: {} },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"p": ' },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '"P1"}' },
            },
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
            { type: "message_stop" },
          ];
          return (async function* () {
            for (const e of events) yield e;
          })();
        }
        return {
          id: "msg_1",
          model: "claude-haiku-4-5-20251001",
          role: "assistant",
          content: [{ type: "text", text: "P1" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
    },
  };
}

describe("wrapAnthropic", () => {
  it("records messages.create", async () => {
    const { ov, steps } = capture();
    const client = ov.wrapAnthropic(fakeAnthropic());
    const run = ov.startRun({ agent: "a" });
    await run.context(async () => {
      await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        system: "be brief",
        messages: [{ role: "user", content: "hi" }],
      });
    });
    await ov.flush();
    const step = steps()[0]!;
    expect(step).toMatchObject({
      provider: "anthropic",
      name: "messages",
      model: "claude-haiku-4-5-20251001",
    });
    expect(step.input).toEqual({ system: "be brief", messages: [{ role: "user", content: "hi" }] });
    expect(step.params).toEqual({ max_tokens: 100 });
    expect(step.output).toEqual({
      message: { role: "assistant", content: [{ type: "text", text: "P1" }] },
      finish_reason: "end_turn",
    });
    expect(step.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(step.costUsd).toBeCloseTo((10 * 1 + 2 * 5) / 1e6);
  });

  it("buffers streams", async () => {
    const { ov, steps } = capture();
    const client = ov.wrapAnthropic(fakeAnthropic());
    const run = ov.startRun({ agent: "a" });
    await run.context(async () => {
      const stream = (await client.messages.create({
        model: "m",
        max_tokens: 5,
        messages: [],
        stream: true,
      })) as AsyncIterable<unknown>;
      let n = 0;
      for await (const _e of stream) n++;
      expect(n).toBe(9);
    });
    await ov.flush();
    const step = steps()[0]!;
    const content = (step.output as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content[0]).toEqual({ type: "text", text: "Hello" });
    expect(content[1]).toMatchObject({ type: "tool_use", name: "set_pri", input: { p: "P1" } });
    expect(step.usage).toMatchObject({ inputTokens: 7, outputTokens: 9 });
    expect(assembleMessageStream([]).content).toEqual([]);
  });
});

describe("aiMiddleware", () => {
  it("records generateText", async () => {
    const { ov, steps } = capture();
    const model = wrapLanguageModel({
      model: new MockLanguageModelV2({
        provider: "openai",
        modelId: "gpt-4.1-mini",
        doGenerate: async () => ({
          content: [{ type: "text", text: "P1" }],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          warnings: [],
        }),
      }),
      middleware: ov.aiMiddleware(),
    });
    const run = ov.startRun({ agent: "a" });
    const { text } = await run.context(() => generateText({ model, prompt: "triage", temperature: 0 }));
    expect(text).toBe("P1");
    await ov.flush();
    const step = steps()[0]!;
    expect(step).toMatchObject({
      kind: "llm_call",
      name: "ai.generate",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect((step.input as { messages: unknown[] }).messages).toHaveLength(1);
    expect(step.params).toMatchObject({ temperature: 0 });
    expect(step.output).toEqual({ content: [{ type: "text", text: "P1" }], finish_reason: "stop" });
    expect(step.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(step.costUsd).toBeCloseTo((10 * 0.4 + 2 * 1.6) / 1e6);
  });

  it("records streamText with the assembled output", async () => {
    const { ov, steps } = capture();
    const model = wrapLanguageModel({
      model: new MockLanguageModelV2({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Hel" },
              { type: "text-delta", id: "t1", delta: "lo" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
              },
            ],
          }),
        }),
      }),
      middleware: ov.aiMiddleware(),
    });
    const run = ov.startRun({ agent: "a" });
    const out = await run.context(async () => {
      const result = streamText({ model, prompt: "hi" });
      return result.text;
    });
    expect(out).toBe("Hello");
    await ov.flush();
    const step = steps()[0]!;
    expect(step.name).toBe("ai.stream");
    expect(step.output).toEqual({ content: [{ type: "text", text: "Hello" }], finish_reason: "stop" });
    expect(step.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });
});
