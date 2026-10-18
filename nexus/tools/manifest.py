"""Typed environment capability manifest used to build the agent's tool surface."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..agent.contracts import ContractError


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{label} must be a non-empty string")
    return value


def _strings(value: Any, label: str, *, allow_empty: bool = True) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise ContractError(f"{label} must be an array of non-empty strings")
    if not allow_empty and not value:
        raise ContractError(f"{label} must not be empty")
    if len(set(value)) != len(value):
        raise ContractError(f"{label} must contain unique values")
    return tuple(value)


@dataclass(frozen=True)
class ResourceDefinition:
    resource_id: str
    kind: str
    description: str
    configuration_keys: tuple[str, ...] = ()
    metrics: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, payload: Any) -> "ResourceDefinition":
        item = _object(payload, "resource")
        return cls(
            resource_id=_text(item.get("id"), "resource id"),
            kind=_text(item.get("kind"), "resource kind"),
            description=_text(item.get("description"), "resource description"),
            configuration_keys=_strings(
                item.get("configuration_keys", []),
                "resource configuration_keys",
            ),
            metrics=_strings(item.get("metrics", []), "resource metrics"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.resource_id,
            "kind": self.kind,
            "description": self.description,
            "configuration_keys": list(self.configuration_keys),
            "metrics": list(self.metrics),
        }


@dataclass(frozen=True)
class ProbeDefinition:
    probe_id: str
    description: str
    inputs: dict[str, Any]

    @classmethod
    def from_dict(cls, payload: Any) -> "ProbeDefinition":
        item = _object(payload, "probe")
        inputs = _object(item.get("inputs", {}), "probe inputs")
        if inputs.get("type") != "object":
            raise ContractError("probe inputs schema must have type object")
        return cls(
            probe_id=_text(item.get("id"), "probe id"),
            description=_text(item.get("description"), "probe description"),
            inputs=inputs,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.probe_id,
            "description": self.description,
            "inputs": self.inputs,
        }


@dataclass(frozen=True)
class ActionDefinition:
    action_id: str
    description: str
    allowed_targets: tuple[str, ...]
    parameters: dict[str, Any]
    before_state_keys: tuple[str, ...]
    automatic: bool = False
    requires_rollback: bool = True
    # Optional, for the structured decision: the fault classes this action repairs
    # or mitigates, and whether it takes its target out of service while it runs.
    addresses: tuple[str, ...] = ()
    removes_capacity: bool = False
    restores_service: bool = True  # False for a mitigation such as a drain: the target stays out

    @classmethod
    def from_dict(cls, payload: Any) -> "ActionDefinition":
        item = _object(payload, "action")
        parameters = _object(item.get("parameters", {}), "action parameters")
        if parameters.get("type") != "object":
            raise ContractError("action parameters schema must have type object")
        automatic = item.get("automatic", False)
        requires_rollback = item.get("requires_rollback", True)
        removes_capacity = item.get("removes_capacity", False)
        restores_service = item.get("restores_service", True)
        if not all(isinstance(v, bool) for v in (automatic, requires_rollback, removes_capacity, restores_service)):
            raise ContractError(
                "action automatic, requires_rollback, removes_capacity and restores_service must be booleans"
            )
        return cls(
            action_id=_text(item.get("id"), "action id"),
            description=_text(item.get("description"), "action description"),
            allowed_targets=_strings(
                item.get("allowed_targets"),
                "action allowed_targets",
                allow_empty=False,
            ),
            parameters=parameters,
            before_state_keys=_strings(
                item.get("before_state_keys", []),
                "action before_state_keys",
            ),
            automatic=automatic,
            requires_rollback=requires_rollback,
            addresses=_strings(item.get("addresses", []), "action addresses"),
            removes_capacity=removes_capacity,
            restores_service=restores_service,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.action_id,
            "description": self.description,
            "allowed_targets": list(self.allowed_targets),
            "parameters": self.parameters,
            "before_state_keys": list(self.before_state_keys),
            "automatic": self.automatic,
            "requires_rollback": self.requires_rollback,
            "addresses": list(self.addresses),
            "removes_capacity": self.removes_capacity,
            "restores_service": self.restores_service,
        }


@dataclass(frozen=True)
class EnvironmentManifest:
    environment_id: str
    description: str
    resources: tuple[ResourceDefinition, ...]
    probes: tuple[ProbeDefinition, ...]
    actions: tuple[ActionDefinition, ...] = ()
    artifact_sections: tuple[str, ...] = ()
    verifiers: tuple[str, ...] = ()
    # Optional {fault class: plain description} for the structured decision; "none" means healthy.
    fault_classes: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, payload: Any) -> "EnvironmentManifest":
        item = _object(payload, "environment manifest")
        raw_resources = item.get("resources")
        raw_probes = item.get("probes")
        raw_actions = item.get("actions", [])
        if not isinstance(raw_resources, list) or not raw_resources:
            raise ContractError("environment resources must be a non-empty array")
        if not isinstance(raw_probes, list):
            raise ContractError("environment probes must be an array")
        if not isinstance(raw_actions, list):
            raise ContractError("environment actions must be an array")
        manifest = cls(
            environment_id=_text(item.get("id"), "environment id"),
            description=_text(item.get("description"), "environment description"),
            resources=tuple(ResourceDefinition.from_dict(x) for x in raw_resources),
            probes=tuple(ProbeDefinition.from_dict(x) for x in raw_probes),
            actions=tuple(ActionDefinition.from_dict(x) for x in raw_actions),
            artifact_sections=_strings(
                item.get("artifact_sections", []), "environment artifact_sections"
            ),
            verifiers=_strings(item.get("verifiers", []), "environment verifiers"),
            fault_classes={_text(k, "fault class"): _text(v, "fault class description")
                           for k, v in _object(item.get("fault_classes", {}), "fault_classes").items()},
        )
        manifest._validate_references()
        return manifest

    @property
    def resource_map(self) -> dict[str, ResourceDefinition]:
        return {item.resource_id: item for item in self.resources}

    @property
    def probe_map(self) -> dict[str, ProbeDefinition]:
        return {item.probe_id: item for item in self.probes}

    @property
    def action_map(self) -> dict[str, ActionDefinition]:
        return {item.action_id: item for item in self.actions}

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.environment_id,
            "description": self.description,
            "resources": [item.to_dict() for item in self.resources],
            "probes": [item.to_dict() for item in self.probes],
            "actions": [item.to_dict() for item in self.actions],
            "artifact_sections": list(self.artifact_sections),
            "verifiers": list(self.verifiers),
            "fault_classes": dict(self.fault_classes),
        }

    def _validate_references(self) -> None:
        for label, values in (
            ("resource", [item.resource_id for item in self.resources]),
            ("probe", [item.probe_id for item in self.probes]),
            ("action", [item.action_id for item in self.actions]),
        ):
            if len(values) != len(set(values)):
                raise ContractError(f"{label} IDs must be unique")
        resources = set(self.resource_map)
        for action in self.actions:
            unknown = set(action.allowed_targets) - resources
            if unknown:
                raise ContractError(
                    f"action {action.action_id} has unknown targets: {sorted(unknown)}"
                )
            undeclared = set(action.addresses) - set(self.fault_classes)
            if undeclared:
                raise ContractError(
                    f"action {action.action_id} addresses undeclared fault classes: {sorted(undeclared)}"
                )
