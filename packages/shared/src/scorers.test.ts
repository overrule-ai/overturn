import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  cosine,
  isSubset,
  looksLikeEscalation,
  type ScorerContext,
  score,
} from "./scorers.js";

const fakeEmbed = (text: string): number[] => {
  // bag-of-words into 64 dims
  const v = new Array<number>(64).fill(0);
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 64]! += 1;
  }
  return v;
};
const ctx: ScorerContext = {
  embed: async (t) => fakeEmbed(t),
  judge: async (prompt) => ({
    pass: /P1/.test(prompt.split("Output under test:")[1] ?? ""),
    reason: "has P1",
  }),
};

describe("equals", () => {
  it("normalizes whitespace and case", async () => {
    expect(
      (await score({ scorer: "equals", config: {}, expected: "Hello  World", actual: " hello world " }))
        .passed,
    ).toBe(true);
    expect(
      (await score({ scorer: "equals", config: { caseSensitive: true }, expected: "Hello", actual: "hello" }))
        .passed,
    ).toBe(false);
  });
  it("falls back to semantic", async () => {
    const r = await score(
      {
        scorer: "equals",
        config: { fallback: "semantic", threshold: 0.5 },
        expected: "the outage is fixed now",
        actual: "outage fixed now",
      },
      ctx,
    );
    expect(r.passed).toBe(true);
    expect(r.reason).toMatch(/semantic/);
  });
});

describe("json_match", () => {
  it("subset-matches expected fields", async () => {
    const r = await score({
      scorer: "json_match",
      config: {},
      expected: { priority: "P1" },
      actual: { priority: "P1", team: "billing", reply: "x" },
    });
    expect(r).toMatchObject({ passed: true, score: 1 });
    const bad = await score({
      scorer: "json_match",
      config: {},
      expected: { priority: "P1", team: "billing" },
      actual: { priority: "P2", team: "billing" },
    });
    expect(bad.passed).toBe(false);
    expect(bad.score).toBe(0.5);
    expect(bad.reason).toContain("$.priority");
  });
  it("supports JSONPath fields and ignore", async () => {
    const r = await score({
      scorer: "json_match",
      config: { fields: ["$.a.b", "$.items[*].id"] },
      expected: { a: { b: 1 }, items: [{ id: 1 }, { id: 2 }] },
      actual: { a: { b: 1, c: 9 }, items: [{ id: 1, x: 1 }, { id: 2 }] },
    });
    expect(r.passed).toBe(true);
    const ig = await score({
      scorer: "json_match",
      config: { ignore: ["$.ts"] },
      expected: { ts: 1, v: 1 },
      actual: { ts: 2, v: 1 },
    });
    expect(ig.passed).toBe(true);
  });
  it("isSubset handles arrays and strings", () => {
    expect(isSubset([1, 2], [1, 2]).ok).toBe(true);
    expect(isSubset([1, 2], [1, 2, 3]).ok).toBe(false);
    expect(isSubset("A", " a ").ok).toBe(true);
  });
});

describe("tool_choice", () => {
  it("compares tool name and fingerprint", async () => {
    const expected = { tool_calls: [{ name: "set_priority", args: { ticketId: "T1", priority: "P1" } }] };
    expect(
      (
        await score({
          scorer: "tool_choice",
          config: {},
          expected,
          actual: { tool_calls: [{ name: "set_priority", args: { priority: "P1", ticketId: "T1" } }] },
        })
      ).passed,
    ).toBe(true);
    const diff = await score({
      scorer: "tool_choice",
      config: {},
      expected,
      actual: { tool_calls: [{ name: "set_priority", args: { ticketId: "T1", priority: "P2" } }] },
    });
    expect(diff).toMatchObject({ passed: false, score: 0.5 });
    expect(
      (
        await score({
          scorer: "tool_choice",
          config: { matchOn: ["ticketId"] },
          expected,
          actual: { tool_calls: [{ name: "set_priority", args: { ticketId: "T1", priority: "P2" } }] },
        })
      ).passed,
    ).toBe(true);
    expect((await score({ scorer: "tool_choice", config: {}, expected, actual: "no tools" })).passed).toBe(
      false,
    );
    expect(
      (
        await score({
          scorer: "tool_choice",
          config: {},
          expected,
          actual: { tool_calls: [{ name: "assign_team", args: {} }] },
        })
      ).reason,
    ).toMatch(/expected tool set_priority/);
  });
});

describe("semantic", () => {
  it("uses cosine similarity", async () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    const r = await score(
      { scorer: "semantic", config: { threshold: 0.9 }, expected: "refund issued", actual: "refund issued" },
      ctx,
    );
    expect(r.passed).toBe(true);
    expect((await score({ scorer: "semantic", config: {}, expected: "a", actual: "b" })).reason).toMatch(
      /needs an embedding/,
    );
  });
});

describe("judge, not_equals, should_escalate", () => {
  it("judge builds a rubric prompt and uses the verdict", async () => {
    const prompt = buildJudgePrompt({
      scorer: "judge",
      config: {},
      expected: "P1",
      actual: "P2",
      note: "enterprise rule",
    });
    expect(prompt).toContain("Reviewer's note (rubric):\nenterprise rule");
    expect(prompt).toContain("Output under test:\nP2");
    expect((await score({ scorer: "judge", config: {}, expected: "x", actual: "P1" }, ctx)).passed).toBe(
      true,
    );
    expect((await score({ scorer: "judge", config: {}, expected: "x", actual: "P2" }, ctx)).passed).toBe(
      false,
    );
  });
  it("not_equals fails on the rejected output and can defer to the judge", async () => {
    const expected = { not_equals: { team: "infra" }, rubric: "needs P1" };
    expect(
      (await score({ scorer: "not_equals", config: {}, expected, actual: { team: "infra" } })).passed,
    ).toBe(false);
    expect(
      (await score({ scorer: "not_equals", config: {}, expected, actual: { team: "billing" } })).passed,
    ).toBe(true);
    const judged = await score(
      {
        scorer: "not_equals",
        config: { judge: true },
        expected,
        actual: { team: "billing", priority: "P2" },
        kind: "reject",
      },
      ctx,
    );
    expect(judged.passed).toBe(false);
    expect(judged.reason).toMatch(/judge/);
  });
  it("should_escalate detects escalation shapes", () => {
    expect(looksLikeEscalation({ tool_calls: [{ name: "escalate_to_human", args: {} }] })).toBe(true);
    expect(looksLikeEscalation({ action: "handoff" })).toBe(true);
    expect(looksLikeEscalation("I will escalate this to a supervisor")).toBe(true);
    expect(looksLikeEscalation({ priority: "P1" })).toBe(false);
  });
  it("should_escalate scores", async () => {
    expect(
      (
        await score({
          scorer: "should_escalate",
          config: {},
          expected: { should_escalate: true, rubric: null },
          actual: { escalate: true },
        })
      ).passed,
    ).toBe(true);
    expect(
      (
        await score({
          scorer: "should_escalate",
          config: {},
          expected: { should_escalate: true, rubric: null },
          actual: { priority: "P3" },
        })
      ).passed,
    ).toBe(false);
  });
});
