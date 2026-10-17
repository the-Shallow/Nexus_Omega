"""Run issue-derived source diagnosis scenarios against a local vLLM clone."""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from nexus.agent.budgets import RunBudget
from nexus.agent.contracts import DiagnosticInput
from nexus.agent.controller import AgentController
from nexus.agent.evidence import EvidenceLedger
from nexus.agent.policy import RepairPolicy, RepairPrecheck
from nexus.app import _result_payload
from nexus.evaluation.catalog import IssueCandidateCatalog
from nexus.evaluation.scenario import ScenarioDefinition
from nexus.evaluation.verification import verify_diagnosis
from nexus.infrastructure.events import JsonlEventLog
from nexus.infrastructure.local_workspace import LocalWorkspaceProvider
from nexus.infrastructure.nemotron import VLLMClientConfig, VLLMNemotronClient
from nexus.infrastructure.repository import BoundedRepository
from nexus.infrastructure.worktrees import create_isolated_worktree
from nexus.tools.environment import EnvironmentTools


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CANDIDATES = ("VLLM-55530", "VLLM-59218", "VLLM-56943")


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def run_scenario(candidate_id: str, repository: Path, artifact_root: Path) -> bool:
    candidate = IssueCandidateCatalog.from_csv(
        ROOT / "data" / "issue-candidates.csv"
    ).get(candidate_id)
    if candidate.reproduction_class != "exact_reproduction" or candidate.execution_mode != "real":
        raise ValueError(f"candidate is not an exact, real reproduction: {candidate_id}")
    scenario = ScenarioDefinition.from_file(
        ROOT / "scenarios" / "vllm" / candidate_id / "scenario.json"
    )
    if scenario.candidate_id != candidate_id or candidate.upstream_url.rsplit("/", 1)[-1] != candidate_id.split("-", 1)[-1]:
        raise ValueError(f"scenario does not match catalog candidate: {candidate_id}")
    run_id = f"{candidate_id.lower()}-{uuid.uuid4().hex[:8]}"
    run_root = artifact_root / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    _write_json(run_root / "candidate.json", candidate.to_dict())
    _write_json(
        run_root / "scenario-metadata.json",
        {"id": scenario.scenario_id, "candidate_id": candidate_id, "revision": scenario.revision},
    )
    try:
        revision = create_isolated_worktree(
            repository, run_root / "workspace", scenario.revision
        )
        provider = LocalWorkspaceProvider(
            run_root / "workspace", scenario, run_root / "probes", ROOT
        )
        reproduction = provider.run_probe("reproduce", {})
        _write_json(run_root / "reproduction.json", reproduction)
        if reproduction.get("reproduced") is not True or reproduction.get("exit_code") != 0:
            _write_json(
                run_root / "verification.json",
                {"passed": False, "reason": "pinned reproduction did not complete and reproduce"},
            )
            print(f"{candidate_id}: reproduction unavailable; see {run_root}")
            return False
        now = datetime.now(timezone.utc).isoformat()
        diagnostic_input = DiagnosticInput.from_dict(
            {
                "trigger_id": run_id,
                "summary": reproduction.get("summary", "Pinned regression observation"),
                "observed_at": now,
                "affected_resources": ["vllm-source"],
                "initial_observations": [
                    {
                        "source_type": "probe_result",
                        "source": f"probe:reproduce:{reproduction['artifact_id']}",
                        "finding": reproduction.get("summary", "Regression reproduced"),
                        "content": reproduction,
                        "trust": "trusted",
                        "resource_id": "vllm-source",
                        "observed_at": now,
                    }
                ],
                "correlation_ids": {"revision": revision},
            }
        )
        _write_json(run_root / "diagnostic-input.json", diagnostic_input.to_dict())
        controller = AgentController(
            run_id=run_id,
            client=VLLMNemotronClient(VLLMClientConfig.from_env()),
            tools=EnvironmentTools(
                provider,
                scenario.environment,
                BoundedRepository(run_root / "workspace", allowed_roots=scenario.allowed_roots),
            ),
            evidence=EvidenceLedger(run_root),
            event_log=JsonlEventLog(run_root / "events.jsonl", run_id),
            repair_precheck=RepairPrecheck(RepairPolicy(scenario.environment), provider),
            run_budget=RunBudget(
                max_steps=12,
                max_tool_calls=15,
                max_total_operations=24,
                timeout_seconds=600,
            ),
        )
        result = controller.run(diagnostic_input)
        _write_json(run_root / "result.json", _result_payload(result))
        report = verify_diagnosis(scenario, reproduction, result)
        _write_json(run_root / "verification.json", report.to_dict())
        print(f"{candidate_id}: {result.state}, verification={'PASS' if report.passed else 'FAIL'}; {run_root}")
        return report.passed
    except Exception as exc:
        _write_json(
            run_root / "error.json",
            {"error_type": type(exc).__name__, "message": str(exc)},
        )
        print(f"{candidate_id}: ERROR ({type(exc).__name__}: {exc}); {run_root}", file=sys.stderr)
        return False


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run pinned vLLM diagnosis scenarios")
    parser.add_argument("--vllm-repo", type=Path, required=True)
    parser.add_argument("--candidate", choices=DEFAULT_CANDIDATES, action="append")
    parser.add_argument("--artifact-dir", type=Path, default=ROOT / "artifacts" / "issue-scenarios")
    args = parser.parse_args(argv)
    selected = args.candidate or list(DEFAULT_CANDIDATES)
    results = [run_scenario(candidate, args.vllm_repo, args.artifact_dir) for candidate in selected]
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
