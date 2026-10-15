"""Approximate list prices, USD per 1M tokens: (input, output). Mirrors packages/shared/src/pricing.ts."""

from __future__ import annotations

import re

from .types import Usage

_PRICES: dict[str, tuple[float, float]] = {
    "gpt-4.1": (2, 8),
    "gpt-4.1-mini": (0.4, 1.6),
    "gpt-4.1-nano": (0.1, 0.4),
    "gpt-4o": (2.5, 10),
    "gpt-4o-mini": (0.15, 0.6),
    "gpt-5": (1.25, 10),
    "gpt-5-mini": (0.25, 2),
    "gpt-5-nano": (0.05, 0.4),
    "o3": (2, 8),
    "o4-mini": (1.1, 4.4),
    "claude-sonnet-4-5": (3, 15),
    "claude-sonnet-4": (3, 15),
    "claude-haiku-4-5": (1, 5),
    "claude-3-5-haiku": (0.8, 4),
    "claude-opus-4-1": (15, 75),
    "claude-opus-4": (15, 75),
    "gemini-2.5-pro": (1.25, 10),
    "gemini-2.5-flash": (0.3, 2.5),
    "gemini-2.5-flash-lite": (0.1, 0.4),
    "text-embedding-3-small": (0.02, 0),
    "text-embedding-3-large": (0.13, 0),
}

_DATE_SUFFIX = re.compile(r"[-@](\d{4}-\d{2}-\d{2}|\d{8})$")


def _normalize(model: str) -> str:
    bare = model.split("/", 1)[1] if "/" in model else model
    bare = _DATE_SUFFIX.sub("", bare)
    return bare[: -len("-latest")] if bare.endswith("-latest") else bare


def price_for(model: str) -> tuple[float, float] | None:
    key = _normalize(model)
    if key in _PRICES:
        return _PRICES[key]
    matches = sorted((k for k in _PRICES if key.startswith(k)), key=len, reverse=True)
    return _PRICES[matches[0]] if matches else None


def estimate_cost_usd(model: str | None, usage: Usage | None) -> float | None:
    if not model or usage is None:
        return None
    price = price_for(model)
    if price is None:
        return None
    return ((usage.input_tokens or 0) * price[0] + (usage.output_tokens or 0) * price[1]) / 1_000_000
