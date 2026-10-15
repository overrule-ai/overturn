from __future__ import annotations

import re

from overturn import tool

from .data import Customer, customers, kb

ticket_state: dict[str, dict[str, str]] = {}


@tool(side_effect=False, match_on=["email"])
def lookup_customer(email: str) -> Customer | None:
    """Look up a customer record by email."""
    return next((c for c in customers if c["email"].lower() == email.lower()), None)


@tool(side_effect=False)
def search_kb(query: str) -> list[dict[str, str]]:
    """Search the knowledge base."""
    words = [w for w in re.split(r"[^a-z0-9]+", query.lower()) if len(w) > 2]
    scored: list[tuple[int, str, dict[str, str]]] = []
    for a in kb:
        hay = f"{a['title']} {a['body']} {' '.join(a['tags'])}".lower()
        score = sum(1 for w in words if w in hay)
        if score > 0:
            scored.append((score, a["id"], {"id": a["id"], "title": a["title"], "body": a["body"]}))
    scored.sort(key=lambda s: (-s[0], s[1]))
    return [s[2] for s in scored[:3]]


@tool(side_effect=True, match_on=["ticket_id", "priority"])
def set_priority(ticket_id: str, priority: str) -> dict[str, object]:
    """Set the ticket priority (P0..P3)."""
    ticket_state.setdefault(ticket_id, {})["priority"] = priority
    return {"ok": True, "ticketId": ticket_id, "priority": priority}


@tool(side_effect=True, match_on=["ticket_id", "team"])
def assign_team(ticket_id: str, team: str) -> dict[str, object]:
    """Route the ticket to a team."""
    ticket_state.setdefault(ticket_id, {})["team"] = team
    return {"ok": True, "ticketId": ticket_id, "team": team}
