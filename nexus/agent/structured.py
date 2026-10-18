"""Structured end of a run: assess each resource, then choose one move from a code-built menu.

Live runs showed the model's free-text diagnosis was usually right while the
final step went wrong: it named target-a as misconfigured and repaired
target-b, proposed a restart after writing that every worker was healthy, and
picked an action that cannot help (a restart for a slow link). Following
docs/research/agent-workflow-findings.md (code runs the workflow, the model
fills in judgments; constrain the final choice to valid options), the
controller ends the investigation with two constrained calls:

1. assess: one row per declared resource (finding first, then status, fault
   class and cited evidence). If every row is healthy, the run ends in
   ABSTAIN ("no fault found") and no action can be proposed.
2. choose: a menu of action+target moves built here from the manifest, only
   on resources assessed faulty and only with actions that address their
   fault class. Each move carries the executor's capacity rule as a note
   (blocked when no other resource is serving; "do this after" when it would
   leave another faulty resource unrepairable). "no_action" is always offered.

The result is an ordinary AgentDecision, so RepairPolicy, RepairPrecheck and
the executor apply unchanged.
"""

from __future__ import annotations

import itertools
import json
from dataclasses import dataclass
from typing import Any

from ..tools.manifest import ActionDefinition, EnvironmentManifest
from .contracts import AgentDecision

STATUSES = ("healthy", "degraded", "failed")
DEFAULT_FAULT_CLASSES = {
    "none": "healthy: no evidence of a problem",
    "unknown": "abnormal, but the evidence does not identify a cause",
}
NO_ACTION = "no_action"
CONFIDENCE = {"failed": 0.8, "degraded": 0.6, "healthy": 0.7}


def fault_classes(manifest: EnvironmentManifest) -> dict[str, str]:
    return {**DEFAULT_FAULT_CLASSES, **manifest.fault_classes}


def assess_format(manifest: EnvironmentManifest, evidence_ids: list[str]) -> dict[str, Any]:
    row = {
        "type": "object", "additionalProperties": False,
        "required": ["finding", "status", "fault_class", "evidence"],
        "properties": {
            "finding": {"type": "string", "minLength": 1, "maxLength": 400},
            "status": {"enum": list(STATUSES)},
            "fault_class": {"enum": list(fault_classes(manifest))},
            "evidence": {"type": "array", "minItems": 1, "maxItems": 6,
                         "items": {"type": "string", "enum": evidence_ids}},
        },
    }
    resources = [r.resource_id for r in manifest.resources]
    schema = {
        "type": "object", "additionalProperties": False, "required": ["observations", "assessments"],
        "properties": {
            "observations": {"type": "string", "minLength": 1, "maxLength": 1200},
            "assessments": {"type": "object", "additionalProperties": False, "required": resources,
                            "properties": {r: row for r in resources}},
        },
    }
    return {"type": "json_schema", "json_schema": {"name": "assessment", "schema": schema, "strict": True}}


def assess_request(manifest: EnvironmentManifest) -> str:
    return json.dumps({
        "step": "assess",
        "instructions": (
            "The investigation is over. Assess every resource from the evidence. Write the finding "
            "first, then the status and the fault class it supports, and cite the evidence IDs. "
            "A resource with no evidence of a problem is healthy with fault class none; a healthy "
            "fleet is a normal outcome. Use unknown when something is abnormal but the cause is unclear."
        ),
        "fault_classes": fault_classes(manifest),
    })


def assessment_errors(assessment: dict[str, Any]) -> list[str]:
    """Contradictions code can see; each message names the exact mismatch."""
    errors = []
    for resource_id, row in assessment["assessments"].items():
        if row["status"] == "healthy" and row["fault_class"] != "none":
            errors.append(f"{resource_id} is healthy but has fault class {row['fault_class']}")
        if row["status"] != "healthy" and row["fault_class"] == "none":
            errors.append(f"{resource_id} is {row['status']} but has fault class none")
    return errors


def flag_errors(assessment: dict[str, Any], flags: dict[str, list[str]]) -> list[str]:
    """A resource assessed healthy although the evidence flags it as abnormal.

    Seen live: the finding read "HTTP 400 ... diverging from the reviewed
    configuration ... directly explains the canary failure" while status was
    healthy and fault class none. Probes mark per-resource abnormal signals
    ("flags"); code holds the assessment to them instead of trusting the labels.
    """
    return [f"{resource_id} is assessed healthy, but the evidence flags it: {'; '.join(flags[resource_id])}"
            for resource_id, row in assessment["assessments"].items()
            if row["status"] == "healthy" and flags.get(resource_id)]


def coerce(assessment: dict[str, Any], flags: dict[str, list[str]] | None = None) -> dict[str, Any]:
    """After the one retry, resolve remaining contradictions conservatively.

    A flagged resource still called healthy becomes degraded/unknown: no
    automatic move fits unknown, so the run ends needing a human, never in
    "no fault found".
    """
    for resource_id, row in assessment["assessments"].items():
        if row["status"] == "healthy" and (flags or {}).get(resource_id):
            row["status"], row["fault_class"] = "degraded", "unknown"
        elif row["status"] == "healthy":
            row["fault_class"] = "none"
        elif row["fault_class"] == "none":
            row["fault_class"] = "unknown"
    return assessment


@dataclass(frozen=True)
class Move:
    move_id: str
    action: ActionDefinition
    target: str
    parameters: dict[str, Any]
    note: str | None
    blocked: bool

    def to_dict(self) -> dict[str, Any]:
        out = {"move": self.move_id, "action": self.action.action_id, "target": self.target,
               "parameters": self.parameters, "what_it_does": self.action.description}
        if self.note:
            out["note"] = self.note
        return out


def _parameter_choices(action: ActionDefinition) -> list[dict[str, Any]] | None:
    """Every parameter combination from enums; None if a required parameter is open-ended."""
    properties = action.parameters.get("properties", {})
    required = action.parameters.get("required", [])
    options = []
    for name in required:
        values = properties.get(name, {}).get("enum")
        if not values:
            return None
        options.append([(name, v) for v in values])
    return [dict(combo) for combo in itertools.product(*options)]


def build_moves(manifest: EnvironmentManifest, assessment: dict[str, Any],
                serving: dict[str, bool] | None) -> list[Move]:
    rows = assessment["assessments"]
    faulty = [r for r, row in rows.items() if row["status"] != "healthy"]
    candidates = []
    for action in manifest.actions:
        if not action.automatic or not action.addresses:
            continue
        for target in faulty:
            if target not in action.allowed_targets or rows[target]["fault_class"] not in action.addresses:
                continue
            for parameters in _parameter_choices(action) or []:
                move_id = " ".join([action.action_id, target, *map(str, parameters.values())])
                candidates.append((move_id, action, target, parameters))
    moves = []
    for move_id, action, target, parameters in candidates:
        note, blocked = None, False
        if serving is not None:
            others = {r for r, up in serving.items() if up and r != target}
            if action.removes_capacity and not others:
                note, blocked = (f"blocked now: no other resource is serving, so taking {target} out "
                                 "would cause an outage; restore another resource first"), True
            else:
                after = others | ({target} if action.restores_service else set())
                stranded = [y for y in faulty if y != target and not (after - {y})
                            and any(c[2] == y and c[1].removes_capacity for c in candidates)]
                if stranded:
                    note = (f"do this after repairing {', '.join(stranded)}: afterwards no other resource "
                            f"would be serving, so {', '.join(stranded)} could not be taken out for its repair")
        moves.append(Move(move_id, action, target, parameters, note, blocked))
    return moves


def choose_format(moves: list[Move]) -> dict[str, Any]:
    open_moves = [m.move_id for m in moves if not m.blocked] + [NO_ACTION]
    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["reasoning", "move", "expected_effect", "risk"],
        "properties": {
            "reasoning": {"type": "string", "minLength": 1, "maxLength": 800},
            "move": {"enum": open_moves},
            "expected_effect": {"type": "string", "minLength": 1, "maxLength": 300},
            "risk": {"type": "string", "minLength": 1, "maxLength": 300},
        },
    }
    return {"type": "json_schema", "json_schema": {"name": "choice", "schema": schema, "strict": True}}


def choose_request(assessment: dict[str, Any], moves: list[Move]) -> str:
    return json.dumps({
        "step": "choose",
        "instructions": (
            "Choose exactly one move to apply now, or no_action. Only the moves listed are possible. "
            "Prefer the move that restores service for users, and follow each move's note about order. "
            "Reason first, then give the move, its expected effect and its risk."
        ),
        "assessment": assessment["assessments"],
        "moves": [m.to_dict() for m in moves if not m.blocked],
        "blocked_moves": [m.to_dict() for m in moves if m.blocked],
    })


def _hypotheses(rows: dict[str, Any], resources: list[str]) -> list[dict[str, Any]]:
    return [{"id": f"{r}:{rows[r]['fault_class']}", "confidence": CONFIDENCE[rows[r]["status"]],
             "supports": list(dict.fromkeys(rows[r]["evidence"])), "contradicts": []} for r in resources]


def abstain(assessment: dict[str, Any] | None, summary: str, stop_reason: str) -> AgentDecision:
    rows = (assessment or {}).get("assessments", {})
    faulty = [r for r, row in rows.items() if row["status"] != "healthy"]
    return AgentDecision.from_json(json.dumps({
        "state": "ABSTAIN", "summary": summary[:1200], "hypotheses": _hypotheses(rows, faulty),
        "stop_reason": stop_reason,
    }))


def plan(manifest: EnvironmentManifest, assessment: dict[str, Any], move: Move,
         choice: dict[str, Any]) -> AgentDecision:
    rows = assessment["assessments"]
    faulty = [r for r, row in rows.items() if row["status"] != "healthy"]
    order = [move.target] + [r for r in faulty if r != move.target]
    hypotheses = _hypotheses(rows, order)
    lead = hypotheses[0]
    return AgentDecision.from_json(json.dumps({
        "state": "PLAN",
        "summary": f"{assessment['observations']} Chosen: {move.move_id}. {choice['reasoning']}"[:1200],
        "hypotheses": hypotheses,
        "stop_reason": None,
        "repair_plan": {
            "hypothesis_id": lead["id"], "confidence": lead["confidence"], "evidence": lead["supports"],
            "action": {"tool": "apply_action", "arguments": {
                "action_id": move.action.action_id, "target": move.target, "parameters": move.parameters}},
            "expected_effect": choice["expected_effect"], "risk": choice["risk"],
            "verification_plan": list(manifest.verifiers) or ["independent verification by the executor"],
            "rollback_plan": "The executor restores the captured before-state if verification fails.",
        },
    }))
