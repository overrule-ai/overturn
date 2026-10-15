"""Runs the Python triage agent over the 30 tickets and records every run.

    OVERTURN_API_KEY=ov_live_... uv run python -m triage.seed

Without OPENAI_API_KEY it expects the fake model server at FAKE_OPENAI_URL
(default http://127.0.0.1:4010/v1): `pnpm --filter @overturn/example-ticket-triage fake-openai`.
"""

from __future__ import annotations

import sys

from overturn import Overturn

from .agent import make_agent, make_openai
from .data import tickets
from .prompts import PROMPT_VERSION


def seed(ov: Overturn, limit: int | None = None, tags: list[str] | None = None) -> list[str]:
    openai, model, _fake = make_openai(ov)
    triage = make_agent(openai, model)
    run_ids: list[str] = []
    for ticket in tickets[: limit or len(tickets)]:
        with ov.run(
            agent="ticket-triage",
            version=f"1.0.0+{PROMPT_VERSION}",
            input=ticket,
            external_id=ticket["id"],
            tags=tags or ["prod", "seed", "python"],
            metadata={"model": model, "promptVersion": PROMPT_VERSION, "sdk": "python"},
        ) as run:
            decision = triage(ticket)
            run.end(output=decision)
            run_ids.append(run.id)
    ov.flush()
    return run_ids


if __name__ == "__main__":
    client = Overturn(debug=True)
    ids = seed(client)
    client.shutdown()
    print(f"recorded {len(ids)} runs", file=sys.stderr)
