import { describe, expect, it } from "vitest";
import { defaultScorer, expectedFor, extractAnswer } from "./cases.js";

describe("extractAnswer", () => {
  it("parses JSON text from an OpenAI message", () => {
    expect(
      extractAnswer({ message: { role: "assistant", content: '{"priority":"P1"}' }, finish_reason: "stop" }),
    ).toEqual({ priority: "P1" });
  });
  it("keeps plain text", () => {
    expect(extractAnswer({ message: { content: "hello" } })).toBe("hello");
  });
  it("extracts OpenAI tool calls", () => {
    expect(
      extractAnswer({
        message: {
          content: null,
          tool_calls: [{ type: "function", function: { name: "set_priority", arguments: '{"p":"P1"}' } }],
        },
      }),
    ).toEqual({ tool_calls: [{ name: "set_priority", args: { p: "P1" } }] });
  });
  it("extracts Anthropic content blocks", () => {
    expect(
      extractAnswer({
        message: {
          content: [
            { type: "text", text: "ok " },
            { type: "tool_use", name: "t", input: { a: 1 } },
          ],
        },
      }),
    ).toEqual({ tool_calls: [{ name: "t", args: { a: 1 } }] });
    expect(extractAnswer({ message: { content: [{ type: "text", text: '{"a":1}' }] } })).toEqual({ a: 1 });
  });
  it("extracts AI SDK parts", () => {
    expect(extractAnswer({ content: [{ type: "text", text: "P1" }], finish_reason: "stop" })).toBe("P1");
  });
  it("handles null", () => {
    expect(extractAnswer(null)).toBeNull();
  });
});

describe("expectedFor + defaultScorer", () => {
  it("edit uses the corrected output and picks json_match for objects", () => {
    const e = expectedFor("edit", { priority: "P2" }, { priority: "P1" }, null);
    expect(e).toEqual({ priority: "P1" });
    expect(defaultScorer("edit", e, null)).toEqual({ scorer: "json_match", config: {} });
  });
  it("approve uses the original", () => {
    expect(expectedFor("approve", "yes", undefined, null)).toBe("yes");
    expect(defaultScorer("approve", "yes", null).scorer).toBe("equals");
    expect(defaultScorer("approve", "y".repeat(300), null).scorer).toBe("judge");
  });
  it("reject and escalate", () => {
    expect(expectedFor("reject", { a: 1 }, undefined, "too slow")).toEqual({
      not_equals: { a: 1 },
      rubric: "too slow",
    });
    expect(defaultScorer("reject", null, "too slow")).toEqual({
      scorer: "not_equals",
      config: { judge: true },
    });
    expect(expectedFor("escalate", null, undefined, null)).toEqual({ should_escalate: true, rubric: null });
    expect(defaultScorer("escalate", null, null)).toEqual({ scorer: "should_escalate", config: {} });
  });
  it("tool decisions pick tool_choice", () => {
    expect(defaultScorer("approve", { tool_calls: [{ name: "t", args: {} }] }, null).scorer).toBe(
      "tool_choice",
    );
  });
});
