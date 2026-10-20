import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows `limit` hits per window, then resets", () => {
    let now = 1_000;
    const rl = new RateLimiter(2, 100, () => now);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true);
    now = 1_101;
    expect(rl.allow("a")).toBe(true);
  });
});
