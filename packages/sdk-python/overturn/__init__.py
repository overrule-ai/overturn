"""Overturn Python SDK.

from overturn import Overturn, tool

ov = Overturn(api_key=os.environ["OVERTURN_API_KEY"])
client = ov.wrap_openai(OpenAI())

@tool(side_effect=False, match_on=["email"])
def lookup_customer(email: str) -> dict: ...

with ov.run(agent="ticket-triage", version="1.4.0", input=ticket) as run:
    ...
    run.end(output=decision)
"""

from .client import Overturn
from .context import current_run
from .fingerprint import FINGERPRINT_VERSION, canonical_json, fingerprint, hash_json, tool_fingerprint
from .pricing import estimate_cost_usd
from .replay import ReplayState, SideEffectRefusedError, ToolRecording, ToolRecordings, UnreplayableError
from .run import Run
from .tools import Tool, tool
from .transport import Transport, TransportError
from .types import IngestPayload, RunUpsert, StepUpsert, Usage

__version__ = "0.1.0"

__all__ = [
    "FINGERPRINT_VERSION",
    "IngestPayload",
    "Overturn",
    "ReplayState",
    "Run",
    "RunUpsert",
    "SideEffectRefusedError",
    "StepUpsert",
    "Tool",
    "ToolRecording",
    "ToolRecordings",
    "Transport",
    "TransportError",
    "UnreplayableError",
    "Usage",
    "__version__",
    "canonical_json",
    "current_run",
    "estimate_cost_usd",
    "fingerprint",
    "hash_json",
    "tool",
    "tool_fingerprint",
]
