"""Deterministic policy and precheck preparation for proposed repairs."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .contracts import ContractError, RepairPlan


class RepairStateBackend(Protocol):
    """Return redacted current state before a repair may be approved."""

    def get_launch_config(self, service: str) -> dict[str, Any]: ...


@dataclass(frozen=True)
class ApprovedServingProfile:
    name: str
    tool_call_parser: str
    chat_template: str
    enable_auto_tool_choice: bool = True

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("profile name must be non-empty")
        if not self.tool_call_parser.strip() or not self.chat_template.strip():
            raise ValueError("approved profiles require a parser and chat template")

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "tool_call_parser": self.tool_call_parser,
            "chat_template": self.chat_template,
            "enable_auto_tool_choice": self.enable_auto_tool_choice,
        }


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
    service: str
    profile: ApprovedServingProfile
    before_state: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "change_id": self.change_id,
            "rollback_token": self.rollback_token,
            "service": self.service,
            "profile": self.profile.to_dict(),
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
    """Allow only reviewed serving profiles on explicitly scoped services."""

    ACTION_TOOL = "patch_serving_config"
    ACTION_ARGUMENTS = {"service", "approved_profile"}

    def __init__(
        self,
        *,
        allowed_services: tuple[str, ...],
        approved_profiles: tuple[ApprovedServingProfile, ...],
    ) -> None:
        if not allowed_services or any(not item.strip() for item in allowed_services):
            raise ValueError("allowed_services must contain non-empty service IDs")
        profiles = {profile.name: profile for profile in approved_profiles}
        if not profiles or len(profiles) != len(approved_profiles):
            raise ValueError("approved profile names must be non-empty and unique")
        self.allowed_services = frozenset(allowed_services)
        self.approved_profiles = profiles

    def evaluate(self, plan: RepairPlan) -> PolicyDecision:
        action = plan.action
        if action.tool != self.ACTION_TOOL:
            return PolicyDecision(
                "REJECTED",
                f"repair tool is not allow-listed: {action.tool}",
            )
        supplied = set(action.arguments)
        if supplied != self.ACTION_ARGUMENTS:
            return PolicyDecision(
                "REJECTED",
                "patch_serving_config requires exactly service and approved_profile; "
                "direct or single-sided configuration changes are forbidden",
            )
        service = action.arguments.get("service")
        profile_name = action.arguments.get("approved_profile")
        if not isinstance(service, str) or not service.strip():
            return PolicyDecision("REJECTED", "service must be a non-empty string")
        if not isinstance(profile_name, str) or not profile_name.strip():
            return PolicyDecision(
                "REJECTED", "approved_profile must be a non-empty string"
            )
        if service not in self.allowed_services:
            return PolicyDecision(
                "REQUIRES_APPROVAL",
                f"service is outside the automatic repair allow-list: {service}",
            )
        if profile_name not in self.approved_profiles:
            return PolicyDecision(
                "REJECTED",
                f"serving profile is not approved: {profile_name}",
            )
        return PolicyDecision(
            "APPROVED",
            f"approved profile {profile_name} may be applied to {service}",
        )


class RepairPrecheck:
    """Validate a plan and capture immutable rollback inputs before mutation."""

    def __init__(
        self,
        policy: RepairPolicy,
        backend: RepairStateBackend,
        *,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        self.policy = policy
        self.backend = backend
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
            raise ContractError(
                f"repair plan cites unknown evidence: {sorted(unknown)}"
            )
        supported = hypothesis_evidence.get(plan.hypothesis_id)
        if supported is None:
            raise ContractError(
                f"repair plan cites unknown hypothesis: {plan.hypothesis_id}"
            )
        unrelated = set(plan.evidence) - supported
        if unrelated:
            raise ContractError(
                "repair plan evidence is not supporting its hypothesis: "
                f"{sorted(unrelated)}"
            )
        if self._active is not None:
            return PrecheckResult(
                PolicyDecision(
                    "REJECTED",
                    "a repair is already awaiting execution or verification",
                )
            )
        decision = self.policy.evaluate(plan)
        if decision.status != "APPROVED":
            return PrecheckResult(decision)

        service = plan.action.arguments["service"]
        profile_name = plan.action.arguments["approved_profile"]
        before_state = self.backend.get_launch_config(service)
        if not isinstance(before_state, dict):
            raise ContractError("before-state backend result must be an object")
        if before_state.get("service") not in {None, service}:
            raise ContractError("before-state service does not match repair target")
        if self._contains_sensitive_key(before_state):
            raise ContractError("before-state must be redacted before policy evaluation")
        try:
            frozen_before_state = json.loads(
                json.dumps(before_state, ensure_ascii=False, sort_keys=True)
            )
        except (TypeError, ValueError) as exc:
            raise ContractError("before-state must be JSON serializable") from exc

        approval = PrecheckApproval(
            change_id=f"chg-{self._token_factory()}",
            rollback_token=f"rb-{self._token_factory()}",
            service=service,
            profile=self.policy.approved_profiles[profile_name],
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
