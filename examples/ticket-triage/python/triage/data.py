from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, TypedDict

DATA_DIR = Path(__file__).resolve().parents[2] / "data"

Priority = Literal["P0", "P1", "P2", "P3"]
Team = Literal["infrastructure", "identity", "billing", "integrations", "mobile", "trust", "support"]
PRIORITIES: list[str] = ["P0", "P1", "P2", "P3"]
TEAMS: list[str] = ["infrastructure", "identity", "billing", "integrations", "mobile", "trust", "support"]


class Ticket(TypedDict):
    id: str
    customerEmail: str
    subject: str
    body: str


class Customer(TypedDict):
    email: str
    name: str
    company: str | None
    plan: str
    seats: int


class KbArticle(TypedDict):
    id: str
    title: str
    body: str
    tags: list[str]


class Decision(TypedDict):
    priority: str
    team: str
    reply: str


def _load(name: str) -> object:
    return json.loads((DATA_DIR / name).read_text())


tickets: list[Ticket] = _load("tickets.json")  # type: ignore[assignment]
customers: list[Customer] = _load("customers.json")  # type: ignore[assignment]
kb: list[KbArticle] = _load("kb.json")  # type: ignore[assignment]
