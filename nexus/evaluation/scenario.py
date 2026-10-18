"""Trusted definitions for reproducible issue-derived diagnostic scenarios."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..tools.manifest import EnvironmentManifest


class ScenarioDefinitionError(ValueError):
    """Raised when a checked-in scenario definition is invalid."""


@dataclass(frozen=True)
class ProbeCommand:
    probe_id: str
    argv: tuple[str, ...]
    timeout_seconds: float


@dataclass(frozen=True)
class DiagnosisExpectation:
    action_id: str
    target: str
    expected_paths: tuple[str, ...]
    require_initial_evidence: bool = True
    require_source_evidence: bool = True


@dataclass(frozen=True)
class ScenarioDefinition:
    scenario_id: str
    candidate_id: str
    repository: str
    revision: str
    allowed_roots: tuple[str, ...]
    environment: EnvironmentManifest
    probe_commands: dict[str, ProbeCommand]
    expectation: DiagnosisExpectation

    @classmethod
    def from_file(cls, path: Path) -> "ScenarioDefinition":
        try:
            payload = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ScenarioDefinitionError(f"cannot read scenario: {path}") from exc
        if not isinstance(payload, dict):
            raise ScenarioDefinitionError("scenario must be an object")
        required = {
            "id",
            "candidate_id",
            "repository",
            "revision",
            "allowed_roots",
            "environment",
            "probe_commands",
            "diagnosis_expectation",
        }
        if set(payload) != required:
            raise ScenarioDefinitionError(
                f"scenario fields must be exactly: {sorted(required)}"
            )
        scenario_id = _text(payload["id"], "scenario id")
        candidate_id = _text(payload["candidate_id"], "candidate id")
        repository = _text(payload["repository"], "repository")
        revision = _text(payload["revision"], "revision")
        allowed_roots = _strings(payload["allowed_roots"], "allowed_roots")
        environment = EnvironmentManifest.from_dict(payload["environment"])

        raw_commands = payload["probe_commands"]
        if not isinstance(raw_commands, dict) or not raw_commands:
            raise ScenarioDefinitionError("probe_commands must be a non-empty object")
        commands: dict[str, ProbeCommand] = {}
        for probe_id, raw in raw_commands.items():
            if probe_id not in environment.probe_map:
                raise ScenarioDefinitionError(
                    f"probe command is not declared by environment: {probe_id}"
                )
            if not isinstance(raw, dict) or set(raw) != {"argv", "timeout_seconds"}:
                raise ScenarioDefinitionError(
                    f"probe command {probe_id} has invalid fields"
                )
            argv = _strings(raw["argv"], f"probe command {probe_id} argv")
            timeout = raw["timeout_seconds"]
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
                raise ScenarioDefinitionError("probe timeout must be numeric")
            if not 1 <= float(timeout) <= 900:
                raise ScenarioDefinitionError("probe timeout must be between 1 and 900")
            commands[probe_id] = ProbeCommand(probe_id, argv, float(timeout))
        if set(commands) != set(environment.probe_map):
            raise ScenarioDefinitionError(
                "every declared probe must have exactly one command"
            )

        raw_expectation = payload["diagnosis_expectation"]
        if not isinstance(raw_expectation, dict):
            raise ScenarioDefinitionError("diagnosis_expectation must be an object")
        expected_fields = {
            "action_id",
            "target",
            "expected_paths",
            "require_initial_evidence",
            "require_source_evidence",
        }
        if set(raw_expectation) != expected_fields:
            raise ScenarioDefinitionError(
                f"diagnosis_expectation fields must be exactly: {sorted(expected_fields)}"
            )
        expectation = DiagnosisExpectation(
            action_id=_text(raw_expectation["action_id"], "expected action_id"),
            target=_text(raw_expectation["target"], "expected target"),
            expected_paths=_strings(
                raw_expectation["expected_paths"], "expected_paths"
            ),
            require_initial_evidence=_boolean(
                raw_expectation["require_initial_evidence"],
                "require_initial_evidence",
            ),
            require_source_evidence=_boolean(
                raw_expectation["require_source_evidence"],
                "require_source_evidence",
            ),
        )
        if expectation.action_id not in environment.action_map:
            raise ScenarioDefinitionError("expected action is not declared")
        if expectation.target not in environment.resource_map:
            raise ScenarioDefinitionError("expected target is not declared")
        return cls(
            scenario_id=scenario_id,
            candidate_id=candidate_id,
            repository=repository,
            revision=revision,
            allowed_roots=allowed_roots,
            environment=environment,
            probe_commands=commands,
            expectation=expectation,
        )


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ScenarioDefinitionError(f"{label} must be a non-empty string")
    return value


def _strings(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise ScenarioDefinitionError(f"{label} must be a non-empty string array")
    if len(value) != len(set(value)):
        raise ScenarioDefinitionError(f"{label} must contain unique values")
    return tuple(value)


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise ScenarioDefinitionError(f"{label} must be a boolean")
    return value
