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
class AgentDecision:
    """Structured decision returned after the model has consumed tool results."""

    state: str
    summary: str
    hypotheses: tuple[Hypothesis, ...]
    stop_reason: str | None

    @classmethod
    def from_json(cls, raw: str) -> "AgentDecision":
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ContractError("assistant content is not valid decision JSON") from exc
        item = _require_object(payload, "agent decision")
        allowed_keys = {"state", "summary", "hypotheses", "stop_reason"}
        extra = set(item) - allowed_keys
        if extra:
            raise ContractError(f"agent decision has unsupported fields: {sorted(extra)}")
        missing = allowed_keys - set(item)
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
        )

    def to_dict(self) -> dict[str, Any]:
        return {
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
