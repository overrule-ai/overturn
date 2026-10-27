import { describe, expect, it } from "vitest";
import { answerText, evaluateContract, toolCallsOf } from "./contract.js";

describe("evaluateContract", () => {
  it("tool counts", () => {
    const calls = ["lookup_customer", "search_kb", "search_kb"];
    expect(
      evaluateContract(
        [
          { type: "tool_called", tool: "lookup_customer", count: "once" },
          { type: "tool_called", tool: "search_kb", count: "at_least_once" },
          { type: "tool_called", tool: "refund", count: "never" },
        ],
        { toolCalls: calls, output: "" },
      ),
    ).toEqual([]);
    expect(
      evaluateContract(
        [
          { type: "tool_called", tool: "search_kb", count: "once" },
          { type: "tool_called", tool: "refund", count: "at_least_once" },
          { type: "tool_called", tool: "lookup_customer", count: "never" },
        ],
        { toolCalls: calls, output: "" },
      ),
    ).toEqual([
      "call search_kb exactly once — called 2×",
      "call refund at least once — not called",
      "never call lookup_customer — called 1×",
    ]);
  });

  it("answer contains, case-insensitive by default, searches structured fields", () => {
    const out = { team: "billing", reply: "We refunded $120." };
    expect(
      evaluateContract(
        [
          { type: "answer", contains: "refunded", negate: false, caseSensitive: false },
          { type: "answer", contains: "BILLING", negate: false, caseSensitive: false },
          { type: "answer", contains: "sorry", negate: true, caseSensitive: false },
        ],
        { toolCalls: [], output: out },
      ),
    ).toEqual([]);
    expect(
      evaluateContract([{ type: "answer", contains: "REFUNDED", negate: false, caseSensitive: true }], {
        toolCalls: [],
        output: out,
      }),
    ).toEqual(['answer must contain "REFUNDED" — it does not']);
  });

  it("tool order", () => {
    const rule = { type: "tool_order", first: "lookup_customer", second: "refund" } as const;
    expect(evaluateContract([rule], { toolCalls: ["lookup_customer", "refund"], output: "" })).toEqual([]);
    expect(evaluateContract([rule], { toolCalls: ["refund", "lookup_customer"], output: "" })).toEqual([
      "call lookup_customer before refund — refund came first",
    ]);
    expect(evaluateContract([rule], { toolCalls: ["refund"], output: "" })).toEqual([
      "call lookup_customer before refund — lookup_customer was never called",
    ]);
    // neither called: the order rule has nothing to say (tool_called covers presence)
    expect(evaluateContract([rule], { toolCalls: [], output: "" })).toEqual([]);
  });

  it("toolCallsOf prefers trajectory steps, falls back to a tool decision", () => {
    expect(
      toolCallsOf({ tool_calls: [{ name: "a" }] }, [{ kind: "tool_call", name: "b" }, { kind: "llm_call" }]),
    ).toEqual(["b"]);
    expect(toolCallsOf({ tool_calls: [{ name: "a" }, { name: "c" }] }, null)).toEqual(["a", "c"]);
    expect(toolCallsOf("just text", undefined)).toEqual([]);
  });

  it("answerText", () => {
    expect(answerText("x")).toBe("x");
    expect(answerText({ reply: "hi", priority: "P0" })).toBe("hi");
    expect(answerText({ priority: "P0" })).toBe('{"priority":"P0"}');
    expect(answerText(null)).toBe("");
  });
});
