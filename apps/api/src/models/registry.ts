import { createHash } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { AppConfig } from "../config";

export interface ParsedModel {
  provider: string;
  model: string;
}

export function parseModel(id: string): ParsedModel {
  const i = id.indexOf("/");
  if (i <= 0) throw new Error(`model must be provider/model, got "${id}"`);
  return { provider: id.slice(0, i).toLowerCase(), model: id.slice(i + 1) };
}

/** Max concurrent model calls per provider (rate limits differ a lot). */
export const PROVIDER_CONCURRENCY: Record<string, number> = {
  openai: 8,
  anthropic: 4,
  google: 4,
  openrouter: 4,
  together: 6,
  fake: 16,
};

export class ModelRegistry {
  constructor(private readonly config: AppConfig) {}

  /** The fake provider: an OpenAI-compatible server (examples/ticket-triage fake-openai) for keyless runs. */
  private fakeBaseUrl(): string {
    return process.env.FAKE_OPENAI_URL ?? "http://127.0.0.1:4010/v1";
  }

  /**
   * The judge model to use: the project's choice when its provider has a key, otherwise
   * the cheapest model of the first configured provider, so judge/reject/escalate cases
   * score on a hosted instance that only has (say) an Anthropic key. Null = no provider.
   */
  resolveJudgeModel(preferred: string): string | null {
    const provider = preferred.split("/")[0] ?? "";
    if (this.isConfigured(provider)) return preferred;
    const defaults: Array<[string, string]> = [
      ["openai", "openai/gpt-4.1-mini"],
      ["anthropic", "anthropic/claude-haiku-4-5"],
      ["google", "google/gemini-2.5-flash"],
      ["openrouter", "openrouter/openai/gpt-4.1-mini"],
    ];
    for (const [p, model] of defaults) if (this.isConfigured(p)) return model;
    return null;
  }

  isConfigured(provider: string): boolean {
    switch (provider) {
      case "openai":
        return Boolean(this.config.OPENAI_API_KEY);
      case "anthropic":
        return Boolean(this.config.ANTHROPIC_API_KEY);
      case "google":
        return Boolean(this.config.GOOGLE_GENERATIVE_AI_API_KEY);
      case "openrouter":
        return Boolean(this.config.OPENROUTER_API_KEY);
      case "together":
        return Boolean(this.config.TOGETHER_API_KEY);
      case "fake":
        return true;
      default:
        return false;
    }
  }

  languageModel(id: string): LanguageModel {
    const { provider, model } = parseModel(id);
    switch (provider) {
      case "openai":
        return createOpenAI({ apiKey: this.required("openai", this.config.OPENAI_API_KEY) }).chat(model);
      case "anthropic":
        return createAnthropic({ apiKey: this.required("anthropic", this.config.ANTHROPIC_API_KEY) })(model);
      case "google":
        return createGoogleGenerativeAI({
          apiKey: this.required("google", this.config.GOOGLE_GENERATIVE_AI_API_KEY),
        })(model);
      case "openrouter":
        return createOpenRouter({ apiKey: this.required("openrouter", this.config.OPENROUTER_API_KEY) }).chat(
          model,
        );
      case "together":
        return createOpenAICompatible({
          name: "together",
          baseURL: this.config.TOGETHER_BASE_URL,
          apiKey: this.required("together", this.config.TOGETHER_API_KEY),
        }).chatModel(model);
      case "fake":
        return createOpenAICompatible({
          name: "fake",
          baseURL: this.fakeBaseUrl(),
          apiKey: "fake",
        }).chatModel(model);
      default:
        throw new Error(
          `Unknown provider "${provider}". Use openai/, anthropic/, google/, openrouter/, together/ or fake/.`,
        );
    }
  }

  /**
   * The embedding model to use: the project's choice when its provider has a key, otherwise the
   * first configured provider that embeds (OpenAI, Together, Google). Null = none; fake/ counts.
   */
  resolveEmbeddingModel(preferred: string): string | null {
    const provider = preferred.split("/")[0] ?? "";
    if (this.isConfigured(provider)) return preferred;
    const defaults: Array<[string, string]> = [
      ["openai", "openai/text-embedding-3-small"],
      ["together", "together/BAAI/bge-base-en-v1.5"],
      ["google", "google/text-embedding-004"],
    ];
    for (const [p, model] of defaults) if (this.isConfigured(p)) return model;
    return null;
  }

  /** Embedding model, or null for fake/ which uses a deterministic local embedding. */
  embeddingModel(id: string): EmbeddingModel<string> | null {
    const { provider, model } = parseModel(id);
    switch (provider) {
      case "openai":
        return createOpenAI({ apiKey: this.required("openai", this.config.OPENAI_API_KEY) }).embedding(model);
      case "google":
        return createGoogleGenerativeAI({
          apiKey: this.required("google", this.config.GOOGLE_GENERATIVE_AI_API_KEY),
        }).textEmbedding(model);
      case "together":
        return createOpenAICompatible({
          name: "together",
          baseURL: this.config.TOGETHER_BASE_URL,
          apiKey: this.required("together", this.config.TOGETHER_API_KEY),
        }).textEmbeddingModel(model);
      case "fake":
        return null;
      default:
        throw new Error(`No embedding support for provider "${provider}"`);
    }
  }

  private required(provider: string, key: string | undefined): string {
    if (!key)
      throw new Error(
        `${provider.toUpperCase()}_API_KEY is not set on the server; add it to the API's environment`,
      );
    return key;
  }
}

/** Deterministic bag-of-words embedding (1536 dims) for the fake provider. Not semantic; for tests and offline demos. */
export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  for (const w of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    const h = createHash("sha256").update(w).digest();
    v[h.readUInt16BE(0) % 1536]! += 1;
    v[h.readUInt16BE(2) % 1536]! += 0.5;
  }
  return v;
}
