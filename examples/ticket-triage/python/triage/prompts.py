"""Prompt variants, kept identical to ../src/prompts.ts so both ports record comparable runs."""

from __future__ import annotations

import os

PROMPT_VERSION = os.environ.get("TRIAGE_PROMPT_VERSION", "v1")

_BASE = """You are a support triage agent. Given a ticket, the customer record and relevant knowledge-base articles, decide:
- priority: P0 (platform outage or all users of a company locked out), P1 (production impact for a company, security, or data-loss risk), P2 (a feature is broken for one user, billing errors, API/integration bugs), P3 (questions, feature requests, how-to)
- team: one of infrastructure, identity, billing, integrations, mobile, trust, support. Use the KB article owner when it names one; otherwise support.
- reply: a short, specific first response to the customer (2-3 sentences).
Return only JSON with keys priority, team, reply."""

_ENTERPRISE_RULE = """
Enterprise customers are contractually prioritized: raise the priority one level (P3->P2, P2->P1, P1->P0) for any customer whose plan is "enterprise"."""

_URGENCY_RULE = """
Outage keywords ("down", "outage", "502", "cannot log in", "locked out", "crash") indicate production impact: never classify them below P1."""

PROMPTS: dict[str, str] = {
    "v1": _BASE + _URGENCY_RULE,
    "v2": _BASE + _URGENCY_RULE + _ENTERPRISE_RULE,
    "weak": _BASE,
}


def system_prompt(version: str = PROMPT_VERSION) -> str:
    if version not in PROMPTS:
        raise ValueError(f"Unknown prompt version {version}; known: {', '.join(PROMPTS)}")
    return PROMPTS[version]
