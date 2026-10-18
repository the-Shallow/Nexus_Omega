"""Run issue-derived source diagnosis scenarios against a local vLLM clone."""

from __future__ import annotations

import argparse
import json
import sys
import traceback
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
from nexus.evaluation.source_repair import IsolatedSourceExecutor, SourcePatchPlanner
from nexus.evaluation.verification import verify_diagnosis, verify_repair_reproduction
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


def _print_status(message: str, *, error: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    encoding = stream.encoding or "utf-8"
    print(message.encode(encoding, errors="backslashreplace").decode(encoding), file=stream)


def run_scenario(
    candidate_id: str,
    repository: Path,
    artifact_root: Path,
    *,
    execute_repair: bool = False,
) -> bool:
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
            _print_status(f"{candidate_id}: reproduction unavailable; see {run_root}")
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
        client = VLLMNemotronClient(VLLMClientConfig.from_env())
        ledger = EvidenceLedger(run_root)
        event_log = JsonlEventLog(run_root / "events.jsonl", run_id)
        precheck = RepairPrecheck(RepairPolicy(scenario.environment), provider)
        controller = AgentController(
            run_id=run_id,
            client=client,
            tools=EnvironmentTools(
                provider,
                scenario.environment,
                repository=BoundedRepository(
                    run_root / "workspace", allowed_roots=scenario.allowed_roots
                ),
            ),
            evidence=ledger,
            event_log=event_log,
            repair_precheck=precheck,
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
        if not report.passed or not execute_repair:
            _print_status(f"{candidate_id}: {result.state}, diagnosis={'PASS' if report.passed else 'FAIL'}; {run_root}")
            return report.passed

        plan = result.decision.repair_plan
        assert plan is not None
        proposed_files = plan.action.arguments["parameters"]["files"]
        allowed_files = tuple(
            path for path in proposed_files if path in scenario.expectation.expected_paths
        )
        proposal = SourcePatchPlanner(client, ledger).propose(result, allowed_files)
        _write_json(run_root / "patch-proposal.json", proposal.to_dict())
        event_log.append("source_patch_proposed", proposal.to_dict())
        approval_result = precheck.prepare(
            plan,
            known_evidence={record.evidence_id for record in result.evidence},
            hypothesis_evidence={
                hypothesis.hypothesis_id: set(hypothesis.supports)
                for hypothesis in result.decision.hypotheses
            },
            operator_approved=True,
        )
        if approval_result.policy.status != "APPROVED" or approval_result.approval is None:
            raise RuntimeError("source repair was not approved by the policy precheck")
        _write_json(run_root / "repair-approval.json", approval_result.to_dict())
        executor = IsolatedSourceExecutor(run_root / "workspace", scenario.allowed_roots)
        try:
            diff = executor.apply(proposal, revision)
            (run_root / "patch.diff").write_text(diff, encoding="utf-8")
            event_log.append(
                "source_change_applied",
                {
                    "change_id": approval_result.approval.change_id,
                    "modified_hashes": executor.modified_hashes(),
                },
            )
            post_reproduction = provider.run_probe("reproduce", {})
            _write_json(run_root / "post-repair-reproduction.json", post_reproduction)
            recovery_verification = verify_repair_reproduction(
                reproduction, post_reproduction
            )
            _write_json(
                run_root / "post-repair-verification.json",
                recovery_verification.to_dict(),
            )
            recovered = recovery_verification.passed
            event_log.append("post_change_probe", post_reproduction)
            if recovered:
                precheck.mark_verified(approval_result.approval.change_id)
                recovery = {
                    "state": "VERIFIED",
                    "passed": True,
                    "change_id": approval_result.approval.change_id,
                    "rollback_token": approval_result.approval.rollback_token,
                    "before_revision": revision,
                    "modified_hashes": executor.modified_hashes(),
                    "baseline_artifact_id": reproduction["artifact_id"],
                    "post_change_artifact_id": post_reproduction["artifact_id"],
                }
            else:
                executor.rollback()
                rollback_probe = provider.run_probe("reproduce", {})
                _write_json(run_root / "rollback-reproduction.json", rollback_probe)
                recovery = {
                    "state": "ROLLED_BACK",
                    "passed": False,
                    "change_id": approval_result.approval.change_id,
                    "rollback_token": approval_result.approval.rollback_token,
                    "before_revision": revision,
                    "post_change_artifact_id": post_reproduction["artifact_id"],
                    "rollback_artifact_id": rollback_probe["artifact_id"],
                    "rollback_reproduced": rollback_probe.get("reproduced") is True,
                }
            _write_json(run_root / "recovery.json", recovery)
            event_log.append("repair_run_completed", recovery)
            _print_status(f"{candidate_id}: {recovery['state']}; {run_root}")
            return recovered
        except Exception:
            if executor.modified_hashes():
                executor.rollback()
                event_log.append("source_change_rolled_back", {"reason": "verification error"})
            raise
    except Exception as exc:
        _write_json(
            run_root / "error.json",
            {
                "error_type": type(exc).__name__,
                "message": str(exc),
                "traceback": traceback.format_exc(),
            },
        )
        _print_status(
            f"{candidate_id}: ERROR ({type(exc).__name__}: {exc}); {run_root}",
            error=True,
        )
        return False


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run pinned vLLM diagnosis scenarios")
    parser.add_argument("--vllm-repo", type=Path, required=True)
    parser.add_argument("--candidate", choices=DEFAULT_CANDIDATES, action="append")
    parser.add_argument("--artifact-dir", type=Path, default=ROOT / "artifacts" / "issue-scenarios")
    parser.add_argument(
        "--execute-repair",
        action="store_true",
        help="Approve and test a model-proposed source edit in the isolated worktree",
    )
    args = parser.parse_args(argv)
    selected = args.candidate or list(DEFAULT_CANDIDATES)
    results = [
        run_scenario(
            candidate,
            args.vllm_repo,
            args.artifact_dir,
            execute_repair=args.execute_repair,
        )
        for candidate in selected
    ]
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
