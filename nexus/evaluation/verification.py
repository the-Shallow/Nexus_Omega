"""Deterministic checks for an issue-derived diagnostic run."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..agent.controller import AgentRunResult
from .scenario import ScenarioDefinition


@dataclass(frozen=True)
class VerificationReport:
    passed: bool
    checks: dict[str, bool]
    details: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "checks": self.checks,
            "details": self.details,
        }


def verify_diagnosis(
    scenario: ScenarioDefinition,
    reproduction: dict[str, Any],
    result: AgentRunResult,
) -> VerificationReport:
    plan = result.decision.repair_plan
    action_arguments = plan.action.arguments if plan is not None else {}
    parameters = action_arguments.get("parameters", {})
    proposed_files = parameters.get("files", []) if isinstance(parameters, dict) else []
    cited = {
        evidence_id
        for hypothesis in result.decision.hypotheses
        for evidence_id in hypothesis.supports
    }
    source_ids = {
        record.evidence_id
        for record in result.evidence
        if record.source_type in {"source_file", "repository_search"}
    }
    expected = scenario.expectation
    checks = {
        "real_reproduction_observed": reproduction.get("reproduced") is True,
        "evidence_backed_plan": plan is not None and bool(cited),
        "initial_evidence_cited": (
            not expected.require_initial_evidence or "ev-001" in cited
        ),
        "source_evidence_cited": (
            not expected.require_source_evidence or bool(cited & source_ids)
        ),
        "expected_action": (
            plan is not None
            and plan.action.tool == "apply_action"
            and action_arguments.get("action_id") == expected.action_id
            and action_arguments.get("target") == expected.target
        ),
        "expected_location": bool(set(proposed_files) & set(expected.expected_paths)),
        "safe_terminal_state": result.state
        in {"PLAN", "PRECHECK", "REQUIRES_APPROVAL"},
    }
    return VerificationReport(
        passed=all(checks.values()),
        checks=checks,
        details={
            "candidate_id": scenario.candidate_id,
            "state": result.state,
            "cited_evidence": sorted(cited),
            "source_evidence": sorted(source_ids),
            "proposed_files": proposed_files,
            "expected_paths": list(expected.expected_paths),
        },
    )
