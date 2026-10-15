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
  "text-embedding-3-small": [0.02, 0],
  "text-embedding-3-large": [0.13, 0],
};

function normalizeModel(model: string): string {
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  // strip date suffixes like -2025-04-14 or -20250514 or @20250514
  return bare.replace(/[-@](\d{4}-\d{2}-\d{2}|\d{8})$/, "").replace(/-latest$/, "");
}

export function priceFor(model: string): [number, number] | null {
  const key = normalizeModel(model);
  if (PRICES[key]) return PRICES[key];
  // longest prefix match (e.g. gpt-4o-mini-audio-preview -> gpt-4o-mini)
  const match = Object.keys(PRICES)
    .filter((k) => key.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICES[match]! : null;
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
