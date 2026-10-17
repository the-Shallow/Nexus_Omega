"""Validated data exchanged between the model, controller, and tools."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


ALLOWED_STATES = {
    "INGEST",
    "DIAGNOSE",
    "EXPAND_CONTEXT",
    "PLAN",
    "PRECHECK",
    "ACT",
    "VERIFY",
    "VERIFIED",
    "ROLLED_BACK",
    "REQUIRES_APPROVAL",
    "ABSTAIN",
}


class ContractError(ValueError):
    """Raised when model-controlled data violates a runtime contract."""


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be a JSON object")
    return value


def _require_string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ContractError(f"{label} must be a non-empty string")
    return value


@dataclass(frozen=True)
class ToolCall:
    """One native tool call returned by the vLLM endpoint."""

    call_id: str
    name: str
    arguments: dict[str, Any]

    @classmethod
    def from_vllm(cls, payload: Any) -> "ToolCall":
        item = _require_object(payload, "tool call")
        function = _require_object(item.get("function"), "tool call function")
        raw_arguments = function.get("arguments", "{}")
        if isinstance(raw_arguments, str):
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                raise ContractError("tool call arguments are not valid JSON") from exc
        else:
            arguments = raw_arguments
        return cls(
            call_id=_require_string(item.get("id"), "tool call id"),
            name=_require_string(function.get("name"), "tool name"),
            arguments=_require_object(arguments, "tool call arguments"),
        )

    def to_vllm(self) -> dict[str, Any]:
        return {
            "id": self.call_id,
            "type": "function",
            "function": {
                "name": self.name,
                "arguments": json.dumps(self.arguments, separators=(",", ":")),
            },
        }


@dataclass(frozen=True)
class ModelTurn:
    """A validated assistant message returned by a model client."""

    content: str | None = None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)

    @classmethod
    def from_vllm_message(cls, payload: Any) -> "ModelTurn":
        message = _require_object(payload, "assistant message")
        content = message.get("content")
        if content is not None and not isinstance(content, str):
            raise ContractError("assistant content must be a string or null")
        raw_calls = message.get("tool_calls") or []
        if not isinstance(raw_calls, list):
            raise ContractError("assistant tool_calls must be an array")
        tool_calls = tuple(ToolCall.from_vllm(item) for item in raw_calls)
        if not tool_calls and (content is None or not content.strip()):
            raise ContractError("assistant message contains neither content nor tool calls")
        return cls(content=content, tool_calls=tool_calls)


@dataclass(frozen=True)
class Hypothesis:
    hypothesis_id: str
    confidence: float
    supports: tuple[str, ...]
    contradicts: tuple[str, ...]

    @classmethod
    def from_dict(cls, payload: Any) -> "Hypothesis":
        item = _require_object(payload, "hypothesis")
        allowed_keys = {"id", "confidence", "supports", "contradicts"}
        extra = set(item) - allowed_keys
        if extra:
            raise ContractError(f"hypothesis has unsupported fields: {sorted(extra)}")
        missing = allowed_keys - set(item)
        if missing:
            raise ContractError(f"hypothesis is missing required fields: {sorted(missing)}")
        confidence = item.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise ContractError("hypothesis confidence must be numeric")
        if not 0 <= float(confidence) <= 1:
            raise ContractError("hypothesis confidence must be between 0 and 1")
        supports = item.get("supports", [])
        contradicts = item.get("contradicts", [])
        if not isinstance(supports, list) or not all(isinstance(x, str) for x in supports):
            raise ContractError("hypothesis supports must be an array of strings")
        if not isinstance(contradicts, list) or not all(
            isinstance(x, str) for x in contradicts
        ):
            raise ContractError("hypothesis contradicts must be an array of strings")
        return cls(
            hypothesis_id=_require_string(item.get("id"), "hypothesis id"),
            confidence=float(confidence),
            supports=tuple(supports),
            contradicts=tuple(contradicts),
        )


@dataclass(frozen=True)
class RepairAction:
    """One model-proposed action that remains subject to controller policy."""

    tool: str
    arguments: dict[str, Any]

    @classmethod
    def from_dict(cls, payload: Any) -> "RepairAction":
        item = _require_object(payload, "repair action")
        allowed_keys = {"tool", "arguments"}
        extra = set(item) - allowed_keys
        if extra:
            raise ContractError(
                f"repair action has unsupported fields: {sorted(extra)}"
            )
        missing = allowed_keys - set(item)
        if missing:
            raise ContractError(
                f"repair action is missing required fields: {sorted(missing)}"
            )
        return cls(
            tool=_require_string(item.get("tool"), "repair action tool"),
            arguments=_require_object(
                item.get("arguments"), "repair action arguments"
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {"tool": self.tool, "arguments": dict(self.arguments)}


@dataclass(frozen=True)
class RepairPlan:
    """Evidence-backed repair proposed by the model before policy evaluation."""

    hypothesis_id: str
    confidence: float
    evidence: tuple[str, ...]
    action: RepairAction
    expected_effect: str
    risk: str
    verification_plan: tuple[str, ...]
    rollback_plan: str

    @classmethod
    def from_dict(cls, payload: Any) -> "RepairPlan":
        item = _require_object(payload, "repair plan")
        allowed_keys = {
            "hypothesis_id",
            "confidence",
            "evidence",
            "action",
            "expected_effect",
            "risk",
            "verification_plan",
            "rollback_plan",
        }
        extra = set(item) - allowed_keys
        if extra:
            raise ContractError(f"repair plan has unsupported fields: {sorted(extra)}")
        missing = allowed_keys - set(item)
        if missing:
            raise ContractError(
                f"repair plan is missing required fields: {sorted(missing)}"
            )
        confidence = item.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise ContractError("repair plan confidence must be numeric")
        if not 0 <= float(confidence) <= 1:
            raise ContractError("repair plan confidence must be between 0 and 1")
        evidence = item.get("evidence")
        if (
            not isinstance(evidence, list)
            or not evidence
            or not all(isinstance(value, str) and value.strip() for value in evidence)
        ):
            raise ContractError(
                "repair plan evidence must be a non-empty array of strings"
            )
        verification = item.get("verification_plan")
        if (
            not isinstance(verification, list)
            or not verification
            or not all(
                isinstance(value, str) and value.strip() for value in verification
            )
        ):
            raise ContractError(
                "repair plan verification_plan must be a non-empty array of strings"
            )
        return cls(
            hypothesis_id=_require_string(
                item.get("hypothesis_id"), "repair plan hypothesis_id"
            ),
            confidence=float(confidence),
            evidence=tuple(evidence),
            action=RepairAction.from_dict(item.get("action")),
            expected_effect=_require_string(
                item.get("expected_effect"), "repair plan expected_effect"
            ),
            risk=_require_string(item.get("risk"), "repair plan risk"),
            verification_plan=tuple(verification),
            rollback_plan=_require_string(
                item.get("rollback_plan"), "repair plan rollback_plan"
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "hypothesis_id": self.hypothesis_id,
            "confidence": self.confidence,
            "evidence": list(self.evidence),
            "action": self.action.to_dict(),
            "expected_effect": self.expected_effect,
            "risk": self.risk,
            "verification_plan": list(self.verification_plan),
            "rollback_plan": self.rollback_plan,
        }


@dataclass(frozen=True)
class AgentDecision:
    """Structured decision returned after the model has consumed tool results."""

    state: str
    summary: str
    hypotheses: tuple[Hypothesis, ...]
    stop_reason: str | None
    repair_plan: RepairPlan | None = None

    @classmethod
    def from_json(cls, raw: str) -> "AgentDecision":
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ContractError("assistant content is not valid decision JSON") from exc
        item = _require_object(payload, "agent decision")
        allowed_keys = {
            "state",
            "summary",
            "hypotheses",
            "stop_reason",
            "repair_plan",
        }
        required_keys = {"state", "summary", "hypotheses", "stop_reason"}
        extra = set(item) - allowed_keys
        if extra:
            raise ContractError(f"agent decision has unsupported fields: {sorted(extra)}")
        missing = required_keys - set(item)
        if missing:
            raise ContractError(
                f"agent decision is missing required fields: {sorted(missing)}"
            )
        state = _require_string(item.get("state"), "decision state")
        if state not in ALLOWED_STATES:
            raise ContractError(f"unsupported decision state: {state}")
        raw_hypotheses = item["hypotheses"]
        if not isinstance(raw_hypotheses, list):
            raise ContractError("decision hypotheses must be an array")
        stop_reason = item.get("stop_reason")
        if stop_reason is not None and not isinstance(stop_reason, str):
            raise ContractError("decision stop_reason must be a string or null")
        return cls(
            state=state,
            summary=_require_string(item.get("summary"), "decision summary"),
            hypotheses=tuple(Hypothesis.from_dict(x) for x in raw_hypotheses),
            stop_reason=stop_reason,
            repair_plan=(
                RepairPlan.from_dict(item["repair_plan"])
                if item.get("repair_plan") is not None
                else None
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "state": self.state,
            "summary": self.summary,
            "hypotheses": [
                {
                    "id": item.hypothesis_id,
                    "confidence": item.confidence,
                    "supports": list(item.supports),
                    "contradicts": list(item.contradicts),
                }
                for item in self.hypotheses
            ],
            "stop_reason": self.stop_reason,
        }
        if self.repair_plan is not None:
            payload["repair_plan"] = self.repair_plan.to_dict()
        return payload
