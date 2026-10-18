"""Server-enforced format for the agent's final decision.

The system prompt asks the model for a decision JSON object, and
AgentDecision.from_json validates it. A small model can get the tool steps
right yet drift on the final shape (seen live: Lightning returned hypotheses
as strings instead of objects). When the first answer fails validation, the
controller asks once more with the decision schema passed as vLLM's
response_format, so constrained decoding guarantees the shape. The retry sends
no tools: a constraint on a turn that may call tools would also block the
tool call, so it applies only once the model has chosen to answer.

The canonical schema is schemas/agent-decision.schema.json.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from .contracts import AgentDecision, ContractError, ModelTurn

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schemas" / "agent-decision.schema.json"
CITATION = re.compile(r"^\s*(ev-[0-9]+)\b")


def normalize_citations(raw: str) -> str:
    """Reduce citations like "ev-002: target-a has ..." to "ev-002".

    Seen live: Lightning appended a description to each evidence ID, and the
    controller rejected the plan as citing unknown evidence. Only a leading
    ev-N token is kept; the controller still checks that the ID exists and
    supports its hypothesis, so a fabricated citation is still rejected.
    Content that is not a JSON object is returned unchanged.
    """
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if not isinstance(payload, dict):
        return raw

    def ids(values: object) -> object:
        if not isinstance(values, list):
            return values
        return [CITATION.match(v).group(1) if isinstance(v, str) and CITATION.match(v) else v for v in values]

    for hypothesis in payload.get("hypotheses") or []:
        if isinstance(hypothesis, dict):
            for key in ("supports", "contradicts"):
                hypothesis[key] = ids(hypothesis.get(key))
    plan = payload.get("repair_plan")
    if isinstance(plan, dict):
        plan["evidence"] = ids(plan.get("evidence"))
    return json.dumps(payload)


@lru_cache(maxsize=1)
def decision_response_format() -> dict[str, Any]:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    for key in ("$schema", "$id", "title"):
        schema.pop(key, None)
    return {
        "type": "json_schema",
        "json_schema": {"name": "agent_decision", "schema": schema, "strict": True},
    }


def parse_decision(
    client: Any,
    messages: list[dict[str, Any]],
    turn: ModelTurn,
    *,
    consume_step: Callable[[], None],
    log: Callable[[str, dict[str, Any]], None],
) -> AgentDecision:
    """Validate the final answer; on a contract error, retry once under the schema.

    The retry counts as a step against the run budget. A second invalid
    answer raises ContractError, as before.
    """
    try:
        return AgentDecision.from_json(normalize_citations(turn.content or ""))
    except ContractError as exc:
        first_error = str(exc)
    consume_step()
    log("decision_reformat_requested", {"error": first_error})
    messages.append({"role": "assistant", "content": turn.content or ""})
    messages.append({
        "role": "user",
        "content": (
            f"Your final answer did not match the required decision format: {first_error}. "
            "Return the same decision again as one JSON object that matches the schema. "
            "Each hypothesis must be an object with id, confidence, supports, and contradicts."
        ),
    })
    retry = client.complete(messages, [], response_format=decision_response_format())
    decision = AgentDecision.from_json(normalize_citations(retry.content or ""))
    log("decision_reformatted", {"first_error": first_error, "state": decision.state})
    return decision
