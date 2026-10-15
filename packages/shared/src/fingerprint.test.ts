import { describe, expect, it } from "vitest";
import { canonicalJSON, fingerprint, hashJSON, selectArgs, toolFingerprint } from "./fingerprint.js";
import vectors from "./fingerprint.vectors.json" with { type: "json" };
import { sha256Hex } from "./sha256.js";

describe("sha256", () => {
  it("matches known digests", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a".repeat(1000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
    expect(sha256Hex("héllo ✓")).toBe("5657cdef8a85a584e0e961e6f8247cf5d3f8ed21496ed6fdbcfd43a761e94245");
  });
});

describe("canonicalJSON", () => {
  it("sorts keys recursively", () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("drops null and undefined", () => {
    expect(canonicalJSON({ a: null, b: undefined, c: [1, null, 2] })).toBe('{"c":[1,2]}');
  });
  it("trims strings", () => {
    expect(canonicalJSON({ q: "  hello  " })).toBe('{"q":"hello"}');
  });
  it("normalizes numbers", () => {
    expect(canonicalJSON({ a: 1.0, b: -0, c: 1e21, d: 0.1 + 0.2 })).toBe(
      '{"a":1,"b":0,"c":1e+21,"d":0.30000000000000004}',
    );
  });
  it("keeps array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });
  it("serializes dates as ISO strings", () => {
    expect(canonicalJSON(new Date("2026-01-02T03:04:05.000Z"))).toBe('"2026-01-02T03:04:05.000Z"');
  });
});

describe("selectArgs", () => {
  it("matchOn keeps a subset and wins over ignoreArgs", () => {
    expect(selectArgs({ a: 1, b: 2, c: 3 }, { matchOn: ["a"], ignoreArgs: ["a"] })).toEqual({ a: 1 });
  });
  it("ignoreArgs drops keys", () => {
    expect(selectArgs({ a: 1, ts: 2 }, { ignoreArgs: ["ts"] })).toEqual({ a: 1 });
  });
  it("passes non-objects through", () => {
    expect(selectArgs("x", { matchOn: ["a"] })).toBe("x");
  });
});

describe("fingerprint", () => {
  it("is stable across key order and whitespace", () => {
    const a = toolFingerprint("lookup_customer", { email: "a@b.c ", plan: "pro" });
    const b = toolFingerprint("lookup_customer", { plan: "pro", email: "a@b.c" });
    expect(a).toBe(b);
  });
  it("differs by tool name and kind", () => {
    expect(toolFingerprint("a", {})).not.toBe(toolFingerprint("b", {}));
    expect(fingerprint("tool_call", "a", {})).not.toBe(fingerprint("llm_call", "a", {}));
  });
  it("matches the shared test vectors (contract with the Python SDK)", () => {
    for (const v of vectors) {
      expect(canonicalJSON(v.args), v.name).toBe(v.canonical);
      expect(toolFingerprint(v.tool, v.args, v.options ?? {}), v.name).toBe(v.fingerprint);
    }
  });
  it("hashJSON is stable", () => {
    expect(hashJSON({ a: 1 })).toBe(hashJSON({ a: 1.0 }));
  });
});
