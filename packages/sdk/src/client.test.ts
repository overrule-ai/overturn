import type { IngestPayload, StepUpsert } from "@overturn-ai/shared";
import { toolFingerprint } from "@overturn-ai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Overturn } from "./client.js";
import { assembleChatStream, type OpenAILike } from "./openai.js";
import {
  MaxStepsExceededError,
  type ReplayModelOutput,
  SideEffectRefusedError,
  setGlobalReplay,
  UnreplayableError,
} from "./replay.js";

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
  const steps = () => batches.flatMap((b) => b.steps);
  const runs = () => batches.flatMap((b) => b.runs);
  return { ov, batches, steps, runs };
}

/** A minimal fake OpenAI client with chat.completions.create supporting stream and non-stream. */
type FakeClient = OpenAILike & {
  calls: Record<string, unknown>[];
  chat: { completions: { create: (params: Record<string, unknown>) => Promise<unknown> } };
};
function fakeOpenAI(): FakeClient {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    chat: {
      completions: {
        async create(params: Record<string, unknown>): Promise<unknown> {
          calls.push(params);
          const base = { id: "cmpl_1", model: "gpt-4.1-mini-2025-04-14" };
          if (params.stream) {
            const chunks = [
              {
                ...base,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
              },
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          type: "function",
                          function: { name: "set_pri", arguments: '{"p":' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, function: { arguments: '"P1"}' } }] },
                    finish_reason: "tool_calls",
                  },
                ],
              },
              { ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
            ];
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          }
          return {
            ...base,
            choices: [{ index: 0, message: { role: "assistant", content: "P1" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          };
        },
      },
    },
  };
}

describe("Overturn recording", () => {
  it("records runs, tool calls and llm calls in order with fingerprints", async () => {
    const { ov, steps, runs } = capture();
    const lookup = ov.tool(
      "lookup_customer",
      async (a: { email: string; ts?: number }) => ({ plan: "pro", email: a.email }),
      {
        sideEffect: false,
        matchOn: ["email"],
      },
    );
    const setPriority = ov.tool(
      "set_priority",
      async (_a: { ticketId: string; priority: string }) => ({ ok: true }),
      {
        sideEffect: true,
      },
    );
    const openai = ov.wrapOpenAI(fakeOpenAI());

    const run = ov.startRun({ agent: "triage", version: "1.0.0", input: { id: "T1" }, tags: ["test"] });
    await run.context(async () => {
      await lookup({ email: "a@b.c", ts: 1 });
      await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
      });
      await setPriority({ ticketId: "T1", priority: "P1" });
      run.end({ output: { priority: "P1" } });
    });
    await ov.flush();

    // start and end of the same run are merged into one upsert per batch
    const rs = runs();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({
      id: run.id,
      status: "completed",
      input: { id: "T1" },
      output: { priority: "P1" },
      tags: ["test"],
    });

    const ss = steps();
    expect(ss.map((s) => [s.seq, s.kind, s.name])).toEqual([
      [0, "tool_call", "lookup_customer"],
      [1, "llm_call", "chat.completions"],
      [2, "tool_call", "set_priority"],
    ]);
    expect(ss.every((s) => s.runId === run.id)).toBe(true);
    // fingerprint uses matchOn, so ts is ignored
    expect(ss[0]!.fingerprint).toBe(toolFingerprint("lookup_customer", { email: "a@b.c" }));
    expect(ss[0]!.sideEffect).toBe(false);
    expect(ss[2]!.sideEffect).toBe(true);
    const llm = ss[1]!;
    expect(llm.model).toBe("gpt-4.1-mini-2025-04-14");
    expect(llm.provider).toBe("openai");
    expect(llm.input).toEqual({ messages: [{ role: "user", content: "hi" }] });
    expect(llm.params).toEqual({ temperature: 0 });
    expect(llm.output).toEqual({ message: { role: "assistant", content: "P1" }, finish_reason: "stop" });
    expect(llm.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(llm.costUsd).toBeCloseTo((10 * 0.4 + 2 * 1.6) / 1e6);
  });

  it("buffers streams and records the assembled message with firstTokenMs", async () => {
    const { ov, steps } = capture();
    const openai = ov.wrapOpenAI(fakeOpenAI());
    const run = ov.startRun({ agent: "triage" });
    await run.context(async () => {
      const stream = (await openai.chat.completions.create({
        model: "m",
        messages: [],
        stream: true,
      })) as AsyncIterable<unknown>;
      let n = 0;
      for await (const _c of stream) n++;
      expect(n).toBe(4); // the caller still sees every chunk
      run.end();
    });
    await ov.flush();
    const llm = steps()[0]!;
    const out = llm.output as {
      message: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
    };
    expect(out.message.tool_calls[0]!.function).toEqual({ name: "set_pri", arguments: '{"p":"P1"}' });
    expect(llm.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    expect(typeof llm.usage?.firstTokenMs).toBe("number");
  });

  it("records tool errors and rethrows", async () => {
    const { ov, steps } = capture();
    const boom = ov.tool("boom", async () => {
      throw new Error("kaboom");
    });
    const run = ov.startRun({ agent: "a" });
    await expect(run.context(() => boom({}))).rejects.toThrow("kaboom");
    await ov.flush();
    expect(steps()[0]).toMatchObject({ name: "boom", error: "kaboom" });
  });

  it("does nothing outside a run context", async () => {
    const { ov, steps } = capture();
    const t = ov.tool("t", async (a: number) => a + 1);
    expect(await t(1)).toBe(2);
    await ov.flush();
    expect(steps()).toHaveLength(0);
  });

  it("applies the redact hook", async () => {
    const batches: IngestPayload[] = [];
    const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      batches.push(JSON.parse(String(init?.body)) as IngestPayload);
      return new Response("{}", { status: 202 });
    }) as typeof globalThis.fetch;
    const ov = new Overturn({
      apiKey: "k",
      baseUrl: "http://x",
      transport: { fetch, disableTimer: true },
      redact: (step: StepUpsert) => (step.name === "secret" ? null : { ...step, input: "[redacted]" }),
    });
    const a = ov.tool("a", async (x: { pw: string }) => x.pw.length);
    const secret = ov.tool("secret", async () => 1);
    const run = ov.startRun({ agent: "r" });
    await run.context(async () => {
      await a({ pw: "hunter2" });
      await secret({});
    });
    await ov.flush();
    const steps = batches.flatMap((b) => b.steps);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.input).toBe("[redacted]");
  });

  it("is a no-op without an API key", async () => {
    const ov = new Overturn({ apiKey: "" });
    expect(ov.transport).toBeNull();
    const run = ov.startRun({ agent: "a" });
    await run.context(async () => run.end());
    await ov.flush();
  });

  it("nested runs: each step belongs to the innermost context", async () => {
    const { ov, steps } = capture();
    const t = ov.tool("t", async () => 1);
    const outer = ov.startRun({ agent: "outer" });
    const inner = ov.startRun({ agent: "inner" });
    await outer.context(async () => {
      await t({});
      await inner.context(async () => {
        await t({});
      });
      await t({});
    });
    await ov.flush();
    expect(steps().map((s) => s.runId)).toEqual([outer.id, inner.id, outer.id]);
  });
});

afterEach(() => setGlobalReplay(null));

describe("replay mode (tool guarantees)", () => {
  it("answers from recordings and never executes the real tool", async () => {
    const { ov } = capture();
    let executed = 0;
    const lookup = ov.tool("lookup", async (a: { email: string }) => {
      executed++;
      return { live: a.email };
    });
    const fp = lookup.fingerprint({ email: "a@b.c" });
    ov.replayMode({ [fp]: { name: "lookup", args: { email: "a@b.c" }, output: { recorded: true } } });
    const run = ov.startRun({ agent: "a" });
    const out = await run.context(() => lookup({ email: "a@b.c" }));
    expect(out).toEqual({ recorded: true });
    expect(executed).toBe(0);
  });

  it("throws UnreplayableError for an unseen fingerprint without executing", async () => {
    const { ov } = capture();
    let executed = 0;
    const lookup = ov.tool("lookup", async () => {
      executed++;
      return 1;
    });
    const state = ov.replayMode({});
    await expect(lookup({ email: "new@b.c" })).rejects.toBeInstanceOf(UnreplayableError);
    expect(executed).toBe(0);
    expect(state.calls[0]).toMatchObject({ name: "lookup", status: "unseen" });
  });

  it("refuses sideEffect tools outright even with a recording", async () => {
    const { ov } = capture();
    let executed = 0;
    const send = ov.tool(
      "send_email",
      async () => {
        executed++;
        return "sent";
      },
      { sideEffect: true },
    );
    const fp = send.fingerprint({ to: "x" });
    ov.replayMode({ [fp]: { name: "send_email", args: { to: "x" }, output: "sent" } });
    await expect(send({ to: "x" })).rejects.toBeInstanceOf(SideEffectRefusedError);
    expect(executed).toBe(0);
    ov.exitReplayMode();
    expect(await send({ to: "x" })).toBe("sent");
  });
});

describe("assembleChatStream", () => {
  it("handles plain content", () => {
    const out = assembleChatStream([
      { choices: [{ delta: { role: "assistant", content: "He" } }] },
      { choices: [{ delta: { content: "llo" }, finish_reason: "stop" }] },
    ]);
    expect(out.choices?.[0]?.message).toEqual({ role: "assistant", content: "Hello" });
    expect(out.choices?.[0]?.finish_reason).toBe("stop");
  });
});

describe("replay mode (trajectory)", () => {
  it("swaps model calls for the target, collects steps locally and sends nothing", async () => {
    const { ov, steps, batches } = capture();
    const openai = ov.wrapOpenAI(fakeOpenAI());
    const lookup = ov.tool("lookup", async () => ({ live: true }));
    const fp = lookup.fingerprint({});
    const calls: unknown[] = [];
    const modelCall = async (input: unknown): Promise<ReplayModelOutput> => {
      calls.push(input);
      return {
        text: '{"priority":"P0"}',
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2 },
        modelId: "target-model",
        costUsd: 0,
      };
    };
    const state = ov.replayMode(
      { [fp]: { name: "lookup", args: {}, output: { recorded: true } } },
      { modelCall },
    );
    const run = ov.startRun({ agent: "a" });
    const out = await run.context(async () => {
      await lookup({});
      const completion = (await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "x" }],
      })) as { choices: Array<{ message: { content: string } }>; model: string };
      run.end({ output: completion.choices[0]!.message.content });
      return completion;
    });
    expect(out.model).toBe("target-model");
    expect(out.choices[0]!.message.content).toBe('{"priority":"P0"}');
    expect(calls[0]).toMatchObject({ provider: "openai", messages: [{ role: "user", content: "x" }] });
    expect(state.steps.map((s) => s.name)).toEqual(["lookup", "chat.completions"]);
    expect(state.steps[1]!.model).toBe("target-model");
    await ov.flush();
    expect(batches).toHaveLength(0);
    expect(steps()).toHaveLength(0);
    // a second Overturn instance (e.g. the customer's own) sees the same mode
    const other = new Overturn({
      apiKey: "ov_live_other",
      baseUrl: "http://y",
      transport: { fetch: async () => new Response("{}"), disableTimer: true },
    });
    expect(other.replay).toBe(state);
  });

  it("stops at maxSteps", async () => {
    const { ov } = capture();
    const t = ov.tool("t", async () => 1);
    const fp = t.fingerprint({});
    ov.replayMode({ [fp]: { name: "t", args: {}, output: 1 } }, { maxSteps: 2 });
    const run = ov.startRun({ agent: "a" });
    await expect(
      run.context(async () => {
        await t({});
        await t({});
        await t({});
      }),
    ).rejects.toBeInstanceOf(MaxStepsExceededError);
  });

  it("intercepts Anthropic and AI SDK calls too", async () => {
    const { ov } = capture();
    const modelCall = async (input: { provider: string }): Promise<ReplayModelOutput> => ({
      text: "",
      toolCalls: [{ id: "c1", name: `via_${input.provider}`, args: { a: 1 } }],
      finishReason: "tool-calls",
      usage: {},
      modelId: null,
      costUsd: null,
    });
    ov.replayMode({}, { modelCall });
    const anthropic = ov.wrapAnthropic({
      messages: {
        create: async (_params: Record<string, unknown>) => ({ content: [{ type: "text", text: "real" }] }),
      },
    });
    const msg = (await anthropic.messages.create({ model: "m", max_tokens: 1, messages: [] })) as {
      content: Array<{ type: string; name?: string }>;
    };
    expect(msg.content[0]).toMatchObject({ type: "tool_use", name: "via_anthropic" });
    const { generateText, wrapLanguageModel } = await import("ai");
    const { MockLanguageModelV2 } = await import("ai/test");
    const model = wrapLanguageModel({
      model: new MockLanguageModelV2({
        doGenerate: async () => ({
          content: [{ type: "text", text: "real" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }),
      }),
      middleware: ov.aiMiddleware(),
    });
    const res = await generateText({ model, prompt: "hi" });
    expect(res.toolCalls[0]).toMatchObject({ toolName: "via_ai", input: { a: 1 } });
  });
});
