import type { Usage } from "./schemas.js";

/** USD per 1M tokens: [input, output]. Approximate list prices; unknown models return null. */
const PRICES: Record<string, [number, number]> = {
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-5": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
  o3: [2, 8],
  "o4-mini": [1.1, 4.4],
  "claude-sonnet-4-5": [3, 15],
  "claude-sonnet-4": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "claude-3-5-haiku": [0.8, 4],
  "claude-opus-4-1": [15, 75],
  "claude-opus-4": [15, 75],
  "gemini-2.5-pro": [1.25, 10],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.5-flash-lite": [0.1, 0.4],
  // Together AI serverless list prices (open-weight challengers)
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": [0.88, 0.88],
  "meta-llama/Llama-3.1-70B-Instruct-Turbo": [0.88, 0.88],
  "meta-llama/Llama-3.1-8B-Instruct-Turbo": [0.18, 0.18],
  "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": [0.18, 0.18],
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": [0.27, 0.85],
  "meta-llama/Llama-4-Scout-17B-16E-Instruct": [0.18, 0.59],
  "Qwen/Qwen2.5-72B-Instruct-Turbo": [1.2, 1.2],
  "Qwen/Qwen2.5-7B-Instruct-Turbo": [0.3, 0.3],
  "Qwen/Qwen3-235B-A22B-Instruct-2507-tput": [0.2, 0.6],
  "deepseek-ai/DeepSeek-V3": [1.25, 1.25],
  "mistralai/Mistral-Small-24B-Instruct-2501": [0.8, 0.8],
  "text-embedding-3-small": [0.02, 0],
  "text-embedding-3-large": [0.13, 0],
};

function normalizeModel(model: string): string {
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  // strip date suffixes like -2025-04-14 or -20250514 or @20250514
  return bare.replace(/[-@](\d{4}-\d{2}-\d{2}|\d{8})$/, "").replace(/-latest$/, "");
}

const LOWER: Record<string, [number, number]> = Object.fromEntries(
  Object.entries(PRICES).map(([k, v]) => [k.toLowerCase(), v]),
);

export function priceFor(model: string): [number, number] | null {
  const key = normalizeModel(model).toLowerCase();
  if (LOWER[key]) return LOWER[key];
  // longest prefix match (e.g. gpt-4o-mini-audio-preview -> gpt-4o-mini)
  const match = Object.keys(LOWER)
    .filter((k) => key.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? LOWER[match]! : null;
}

export function estimateCostUsd(
  model: string | null | undefined,
  usage: Usage | null | undefined,
): number | null {
  if (!model || !usage) return null;
  const price = priceFor(model);
  if (!price) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return (input * price[0] + output * price[1]) / 1_000_000;
}
