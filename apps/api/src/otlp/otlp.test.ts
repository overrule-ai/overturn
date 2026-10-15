import type { RunWithSteps } from "@overturn/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, startTestApp, type TestContext } from "../test/harness";
import {
  mapOtlpTraces,
  type OtlpExportTraceServiceRequest,
  type OtlpKeyValue,
  traceIdToUuid,
} from "./otlp-mapper";
import { decodeProtobufTraces, encodeProtobufTraces } from "./otlp-protobuf";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

const s = (v: string): { stringValue: string } => ({ stringValue: v });
const n = (v: number): { intValue: string } => ({ intValue: String(v) });
const attrs = (
  o: Record<
    string,
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { arrayValue: { values: { stringValue: string }[] } }
  >,
): OtlpKeyValue[] => Object.entries(o).map(([key, value]) => ({ key, value }));

const T0 = 1_760_000_000_000_000_000n; // ns
const ns = (ms: number) => String(T0 + BigInt(ms) * 1_000_000n);

/** A GenAI-semconv trace: root agent span -> tool span -> chat span -> tool span. */
function genAiTrace(traceId = "0af7651916cd43dd8448eb211c80319c"): OtlpExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrs({ "service.name": s("ticket-triage-otel"), "service.version": s("2.0.0") }),
        },
        scopeSpans: [
          {
            scope: { name: "my-agent" },
            spans: [
              {
                traceId,
                spanId: "b7ad6b7169203331",
                name: "invoke_agent ticket-triage",
                kind: "SPAN_KIND_INTERNAL",
                startTimeUnixNano: ns(0),
                endTimeUnixNano: ns(1200),
                attributes: attrs({
                  "gen_ai.operation.name": s("invoke_agent"),
                  "gen_ai.agent.name": s("ticket-triage"),
                  "overturn.input": s(JSON.stringify({ id: "T-9", subject: "down" })),
                  "overturn.output": s(JSON.stringify({ priority: "P1" })),
                  "overturn.tags": { arrayValue: { values: [s("prod")] } },
                  "overturn.external_id": s("T-9"),
                }),
                status: { code: "STATUS_CODE_OK" },
              },
              {
                traceId,
                spanId: "1111111111111111",
                parentSpanId: "b7ad6b7169203331",
                name: "execute_tool lookup_customer",
                startTimeUnixNano: ns(10),
                endTimeUnixNano: ns(25),
                attributes: attrs({
                  "gen_ai.operation.name": s("execute_tool"),
                  "gen_ai.tool.name": s("lookup_customer"),
                  "gen_ai.tool.call.arguments": s(JSON.stringify({ email: "a@b.c" })),
                  "gen_ai.tool.call.result": s(JSON.stringify({ plan: "enterprise" })),
                }),
              },
              {
                traceId,
                spanId: "2222222222222222",
                parentSpanId: "b7ad6b7169203331",
                name: "chat gpt-4.1-mini",
                startTimeUnixNano: ns(30),
                endTimeUnixNano: ns(900),
                attributes: attrs({
                  "gen_ai.operation.name": s("chat"),
                  "gen_ai.system": s("openai"),
                  "gen_ai.request.model": s("gpt-4.1-mini"),
                  "gen_ai.response.model": s("gpt-4.1-mini-2025-04-14"),
                  "gen_ai.request.temperature": n(0),
                  "gen_ai.usage.input_tokens": n(120),
                  "gen_ai.usage.output_tokens": n(15),
                  "gen_ai.input.messages": s(JSON.stringify([{ role: "user", content: "triage this" }])),
                  "gen_ai.output.messages": s(
                    JSON.stringify([{ role: "assistant", content: '{"priority":"P1"}' }]),
                  ),
                  "gen_ai.response.finish_reasons": { arrayValue: { values: [s("stop")] } },
                }),
              },
              {
                traceId,
                spanId: "3333333333333333",
                parentSpanId: "b7ad6b7169203331",
                name: "execute_tool set_priority",
                startTimeUnixNano: ns(950),
                endTimeUnixNano: ns(960),
                attributes: attrs({
                  "gen_ai.operation.name": s("execute_tool"),
                  "gen_ai.tool.name": s("set_priority"),
                  "gen_ai.tool.call.arguments": s(JSON.stringify({ ticketId: "T-9", priority: "P1" })),
                  "gen_ai.tool.call.result": s(JSON.stringify({ ok: true })),
                  "overturn.side_effect": { boolValue: true },
                }),
              },
              {
                traceId,
                spanId: "4444444444444444",
                parentSpanId: "b7ad6b7169203331",
                name: "some internal span",
                startTimeUnixNano: ns(5),
                endTimeUnixNano: ns(6),
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("OTLP mapper", () => {
  it("maps a GenAI trace to one run and three steps", () => {
    const { runs, steps } = mapOtlpTraces(genAiTrace());
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.id).toBe(traceIdToUuid("0af7651916cd43dd8448eb211c80319c"));
    expect(run).toMatchObject({
      agent: "ticket-triage",
      agentVersion: "2.0.0",
      status: "completed",
      externalId: "T-9",
      input: { id: "T-9", subject: "down" },
      output: { priority: "P1" },
      tags: ["prod", "otel"],
    });
    expect(steps.map((st) => [st.kind, st.name])).toEqual([
      ["tool_call", "lookup_customer"],
      ["llm_call", "chat"],
      ["tool_call", "set_priority"],
    ]);
    const llm = steps[1]!;
    expect(llm.model).toBe("gpt-4.1-mini-2025-04-14");
    expect(llm.provider).toBe("openai");
    expect(llm.input).toEqual({ messages: [{ role: "user", content: "triage this" }] });
    expect(llm.output).toEqual({
      message: { role: "assistant", content: '{"priority":"P1"}' },
      finish_reason: "stop",
    });
    expect(llm.params).toEqual({ temperature: 0 });
    expect(llm.usage).toEqual({ inputTokens: 120, outputTokens: 15 });
    expect(llm.latencyMs).toBe(870);
    expect(steps[2]!.sideEffect).toBe(true);
    expect(steps[0]!.fingerprint).toHaveLength(64);
    expect(steps[0]!.input).toEqual({ email: "a@b.c" });
  });

  it("marks errored root spans as failed; a batch without the root emits steps but no run", () => {
    const t = genAiTrace();
    t.resourceSpans![0]!.scopeSpans![0]!.spans![0]!.status = { code: "STATUS_CODE_ERROR", message: "boom" };
    expect(mapOtlpTraces(t).runs[0]).toMatchObject({ status: "failed", error: "boom" });
    const partial = genAiTrace();
    partial.resourceSpans![0]!.scopeSpans![0]!.spans!.shift(); // drop the root
    const mapped = mapOtlpTraces(partial);
    expect(mapped.runs).toHaveLength(0);
    expect(mapped.steps).toHaveLength(3);
    expect(mapped.steps[0]!.runId).toBe(traceIdToUuid("0af7651916cd43dd8448eb211c80319c"));
  });

  it("round-trips through protobuf", () => {
    const json = genAiTrace();
    const buf = encodeProtobufTraces({
      resourceSpans: json.resourceSpans!.map((rs) => ({
        ...rs,
        scopeSpans: rs.scopeSpans!.map((ss) => ({
          ...ss,
          spans: ss.spans!.map((sp) => ({
            ...sp,
            traceId: Buffer.from(sp.traceId, "hex"),
            spanId: Buffer.from(sp.spanId, "hex"),
            parentSpanId: sp.parentSpanId ? Buffer.from(sp.parentSpanId, "hex") : undefined,
            kind: 1,
            status: sp.status
              ? { code: sp.status.code === "STATUS_CODE_ERROR" ? 2 : 1, message: sp.status.message }
              : undefined,
          })),
        })),
      })),
    });
    const decoded = decodeProtobufTraces(buf);
    const a = mapOtlpTraces(decoded);
    const b = mapOtlpTraces(json);
    expect(a.runs[0]!.id).toBe(b.runs[0]!.id);
    expect(a.steps.map((st) => st.id)).toEqual(b.steps.map((st) => st.id));
    expect(a.steps[1]!.usage).toEqual(b.steps[1]!.usage);
  });
});

describe("POST /v1/traces", () => {
  it("accepts OTLP/JSON and stores a run with steps", async () => {
    const res = await api<{ runs: number; steps: number }>(ctx, "POST", "/v1/traces", genAiTrace());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runs: 1, steps: 3 });
    const run = await api<RunWithSteps>(
      ctx,
      "GET",
      `/v1/runs/${traceIdToUuid("0af7651916cd43dd8448eb211c80319c")}`,
    );
    expect(run.status).toBe(200);
    expect(run.body.agent).toBe("ticket-triage");
    expect(run.body.steps.map((st) => st.name)).toEqual(["lookup_customer", "chat", "set_priority"]);
    // re-export is idempotent
    await api(ctx, "POST", "/v1/traces", genAiTrace());
    const again = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${run.body.id}`);
    expect(again.body.stepCount).toBe(3);
  });

  it("accepts OTLP protobuf", async () => {
    const traceId = "ffffffffffffffffffffffffffffff01";
    const buf = encodeProtobufTraces({
      resourceSpans: [
        {
          resource: { attributes: attrs({ "service.name": s("proto-agent") }) },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: Buffer.from(traceId, "hex"),
                  spanId: Buffer.from("0000000000000001", "hex"),
                  name: "chat",
                  startTimeUnixNano: ns(0),
                  endTimeUnixNano: ns(100),
                  attributes: attrs({
                    "gen_ai.request.model": s("claude-haiku-4-5"),
                    "gen_ai.system": s("anthropic"),
                  }),
                },
              ],
            },
          ],
        },
      ],
    });
    const res = await fetch(`${ctx.baseUrl}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${ctx.apiKey}` },
      body: Buffer.from(buf),
    });
    expect(res.status).toBe(200);
    const run = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${traceIdToUuid(traceId)}`);
    expect(run.body.agent).toBe("proto-agent");
    expect(run.body.steps[0]).toMatchObject({
      kind: "llm_call",
      model: "claude-haiku-4-5",
      provider: "anthropic",
    });
  });

  it("also serves the /v1/otlp/v1/traces alias", async () => {
    const res = await api(ctx, "POST", "/v1/otlp/v1/traces", genAiTrace("0af7651916cd43dd8448eb211c80319d"));
    expect(res.status).toBe(200);
  });
});
