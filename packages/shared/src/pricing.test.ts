import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor } from "./pricing.js";

describe("pricing", () => {
  it("prices Together serverless challengers by provider/org/model id, case-insensitively", () => {
    expect(priceFor("together/deepseek-ai/DeepSeek-V4.1-Flash")).toEqual([0.3, 1.2]);
    expect(priceFor("together/zai-org/glm-5.3")).toEqual([1.4, 4.4]);
    expect(priceFor("together/moonshotai/Kimi-K3")).toEqual([3, 15]);
  });

  it("strips date suffixes and falls back to the longest prefix", () => {
    expect(priceFor("openai/gpt-4.1-mini-2025-04-14")).toEqual([0.4, 1.6]);
    expect(priceFor("anthropic/claude-sonnet-4-5-20250929")).toEqual([3, 15]);
    expect(priceFor("openai/gpt-4o-mini-audio-preview")).toEqual([0.15, 0.6]);
  });

  it("returns null for unknown models and computes cost from usage", () => {
    expect(priceFor("acme/unknown-model")).toBeNull();
    expect(estimateCostUsd("acme/unknown-model", { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(
      estimateCostUsd("together/deepseek-ai/DeepSeek-V4.1-Flash", {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      }),
    ).toBeCloseTo(0.9);
  });
});
