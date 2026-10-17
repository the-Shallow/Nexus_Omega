"""Deterministic policy and before-state checks for declared repair actions."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from ..infrastructure.target import EnvironmentProvider
from ..tools.manifest import EnvironmentManifest
from ..tools.registry import validate_schema
from .contracts import ContractError, RepairPlan


@dataclass(frozen=True)
class PolicyDecision:
    status: str
    reason: str

    def to_dict(self) -> dict[str, str]:
        return {"status": self.status, "reason": self.reason}


@dataclass(frozen=True)
class PrecheckApproval:
    change_id: str
    rollback_token: str
    action_id: str
    target: str
    parameters: dict[str, Any]
    before_state: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "change_id": self.change_id,
            "rollback_token": self.rollback_token,
            "action_id": self.action_id,
            "target": self.target,
            "parameters": self.parameters,
            "before_state": self.before_state,
        }


@dataclass(frozen=True)
class PrecheckResult:
    policy: PolicyDecision
    approval: PrecheckApproval | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"policy": self.policy.to_dict()}
        if self.approval is not None:
            payload["approval"] = self.approval.to_dict()
        return payload


class RepairPolicy:
    """Evaluate a repair against the actions declared by an environment."""

    ACTION_TOOL = "apply_action"
    ACTION_ARGUMENTS = {"action_id", "target", "parameters"}

    def __init__(self, manifest: EnvironmentManifest) -> None:
        self.manifest = manifest

    def evaluate(self, plan: RepairPlan) -> PolicyDecision:
        action = plan.action
        if action.tool != self.ACTION_TOOL:
            return PolicyDecision("REJECTED", f"repair tool is not allow-listed: {action.tool}")
        if set(action.arguments) != self.ACTION_ARGUMENTS:
            return PolicyDecision(
                "REJECTED",
                "apply_action requires exactly action_id, target, and parameters",
            )
        action_id = action.arguments.get("action_id")
        target = action.arguments.get("target")
        parameters = action.arguments.get("parameters")
        if not isinstance(action_id, str) or not action_id.strip():
            return PolicyDecision("REJECTED", "action_id must be a non-empty string")
        if not isinstance(target, str) or not target.strip():
            return PolicyDecision("REJECTED", "target must be a non-empty string")
        if not isinstance(parameters, dict):
            return PolicyDecision("REJECTED", "parameters must be an object")
        declared = self.manifest.action_map.get(action_id)
        if declared is None:
            return PolicyDecision("REJECTED", f"action is not declared: {action_id}")
        if target not in declared.allowed_targets:
            return PolicyDecision(
                "REJECTED", f"target {target} is not allowed for action {action_id}"
            )
        try:
            validate_schema(parameters, declared.parameters, "action parameters")
        except ContractError as exc:
            return PolicyDecision("REJECTED", str(exc))
        if not declared.automatic:
            return PolicyDecision(
                "REQUIRES_APPROVAL",
                f"declared action requires operator approval: {action_id}",
            )
        return PolicyDecision(
            "APPROVED", f"declared automatic action {action_id} may target {target}"
        )


class RepairPrecheck:
    """Validate evidence and capture rollback inputs before any mutation."""

    def __init__(
        self,
        policy: RepairPolicy,
        provider: EnvironmentProvider,
        *,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        self.policy = policy
        self.provider = provider
        self._token_factory = token_factory or (lambda: uuid.uuid4().hex[:12])
        self._active: PrecheckApproval | None = None

    @property
    def active_approval(self) -> PrecheckApproval | None:
        return self._active

    def prepare(
        self,
        plan: RepairPlan,
        *,
        known_evidence: set[str],
        hypothesis_evidence: dict[str, set[str]],
    ) -> PrecheckResult:
        unknown = set(plan.evidence) - known_evidence
        if unknown:
            raise ContractError(f"repair plan cites unknown evidence: {sorted(unknown)}")
        supported = hypothesis_evidence.get(plan.hypothesis_id)
        if supported is None:
            raise ContractError(f"repair plan cites unknown hypothesis: {plan.hypothesis_id}")
        unrelated = set(plan.evidence) - supported
        if unrelated:
            raise ContractError(
                "repair plan evidence is not supporting its hypothesis: "
                f"{sorted(unrelated)}"
            )
        if self._active is not None:
            return PrecheckResult(
                PolicyDecision(
                    "REJECTED", "a repair is already awaiting execution or verification"
                )
            )
        decision = self.policy.evaluate(plan)
        if decision.status != "APPROVED":
            return PrecheckResult(decision)

        action_id = plan.action.arguments["action_id"]
        target = plan.action.arguments["target"]
        parameters = plan.action.arguments["parameters"]
        declared = self.policy.manifest.action_map[action_id]
        before_state = self.provider.get_configuration(
            target, list(declared.before_state_keys)
        )
        if not isinstance(before_state, dict):
            raise ContractError("before-state provider result must be an object")
        returned_target = before_state.get("resource_id", before_state.get("target"))
        if returned_target not in {None, target}:
            raise ContractError("before-state resource does not match repair target")
        if self._contains_sensitive_key(before_state):
            raise ContractError("before-state must be redacted before policy evaluation")
        try:
            frozen_parameters = json.loads(
                json.dumps(parameters, ensure_ascii=False, sort_keys=True)
            )
            frozen_before_state = json.loads(
                json.dumps(before_state, ensure_ascii=False, sort_keys=True)
            )
        except (TypeError, ValueError) as exc:
            raise ContractError("repair inputs must be JSON serializable") from exc

        approval = PrecheckApproval(
            change_id=f"chg-{self._token_factory()}",
            rollback_token=f"rb-{self._token_factory()}",
            action_id=action_id,
            target=target,
            parameters=frozen_parameters,
            before_state=frozen_before_state,
        )
        self._active = approval
        return PrecheckResult(decision, approval)

    def mark_verified(self, change_id: str) -> None:
        if self._active is None or self._active.change_id != change_id:
            raise ContractError("cannot clear an unknown active repair")
        self._active = None

    @classmethod
    def _contains_sensitive_key(cls, value: Any) -> bool:
        sensitive = {"authorization", "password", "secret", "token", "api_key"}
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = str(key).lower().replace("-", "_")
                if any(marker in normalized for marker in sensitive):
                    return True
                if cls._contains_sensitive_key(child):
                    return True
        elif isinstance(value, list):
            return any(cls._contains_sensitive_key(child) for child in value)
        return False
