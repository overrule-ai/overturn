import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";

describe("resolveJudgeModel", () => {
  it("keeps the project's judge when its provider has a key, else falls back to a configured provider", async () => {
    const { ModelRegistry } = await import("./registry");
    const base = { DATABASE_URL: "postgres://x/y", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
    const only = (keys: Record<string, string>) => new ModelRegistry(loadConfig({ ...base, ...keys }));
    expect(only({ OPENAI_API_KEY: "k" }).resolveJudgeModel("openai/gpt-4.1-mini")).toBe(
      "openai/gpt-4.1-mini",
    );
    expect(only({ ANTHROPIC_API_KEY: "k" }).resolveJudgeModel("openai/gpt-4.1-mini")).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(only({ ANTHROPIC_API_KEY: "k" }).resolveJudgeModel("anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(only({}).resolveJudgeModel("openai/gpt-4.1-mini")).toBeNull();
  });
});
