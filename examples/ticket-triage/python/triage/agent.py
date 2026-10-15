from __future__ import annotations

import json
import os
from collections.abc import Callable

from openai import OpenAI
from openai.types.shared_params import ResponseFormatJSONSchema
from overturn import Overturn

from .data import PRIORITIES, TEAMS, Decision, Ticket
from .prompts import PROMPT_VERSION, system_prompt
from .tools import assign_team, lookup_customer, search_kb, set_priority

DECISION_JSON_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "priority": {"type": "string", "enum": PRIORITIES},
        "team": {"type": "string", "enum": TEAMS},
        "reply": {"type": "string"},
    },
    "required": ["priority", "team", "reply"],
    "additionalProperties": False,
}


RESPONSE_FORMAT: ResponseFormatJSONSchema = {
    "type": "json_schema",
    "json_schema": {"name": "triage_decision", "strict": True, "schema": DECISION_JSON_SCHEMA},
}


def make_openai(ov: Overturn) -> tuple[OpenAI, str, bool]:
    """Real OpenAI when OPENAI_API_KEY is set, else the local fake server (see ../src/fake-openai.ts)."""
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return ov.wrap_openai(OpenAI(api_key=key)), os.environ.get("TRIAGE_MODEL", "gpt-4.1-mini"), False
    base_url = os.environ.get("FAKE_OPENAI_URL", "http://127.0.0.1:4010/v1")
    return (
        ov.wrap_openai(OpenAI(api_key="fake", base_url=base_url)),
        os.environ.get("TRIAGE_MODEL", "fake-triage-v1"),
        True,
    )


def parse_decision(raw: str) -> Decision:
    d = json.loads(raw)
    if (
        d.get("priority") not in PRIORITIES
        or d.get("team") not in TEAMS
        or not isinstance(d.get("reply"), str)
    ):
        raise ValueError(f"invalid decision: {raw}")
    return {"priority": d["priority"], "team": d["team"], "reply": d["reply"]}


def make_agent(
    openai: OpenAI, model: str, prompt_version: str = PROMPT_VERSION
) -> Callable[[Ticket], Decision]:
    def triage(ticket: Ticket) -> Decision:
        customer = lookup_customer(ticket["customerEmail"])
        articles = search_kb(f"{ticket['subject']} {ticket['body']}")
        completion = openai.chat.completions.create(
            model=model,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt(prompt_version)},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"ticket": ticket, "customer": customer, "articles": articles}, indent=2
                    ),
                },
            ],
            response_format=RESPONSE_FORMAT,
        )
        decision = parse_decision(completion.choices[0].message.content or "{}")
        set_priority(ticket["id"], decision["priority"])
        assign_team(ticket["id"], decision["team"])
        return decision

    return triage
