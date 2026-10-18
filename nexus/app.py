"""Composition root and CLI for a live Nexus Omega diagnostic run."""

from __future__ import annotations

import argparse
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from .agent.contracts import DiagnosticInput
from .agent.controller import AgentController, AgentRunResult
from .agent.evidence import EvidenceLedger
from .agent.policy import RepairPolicy, RepairPrecheck
from .infrastructure.events import JsonlEventLog
from .infrastructure.nemotron import VLLMClientConfig, VLLMNemotronClient
from .infrastructure.target import HttpEnvironmentConfig, HttpEnvironmentProvider
from .tools.environment import EnvironmentTools
from .tools.manifest import EnvironmentManifest


def build_live_controller(run_id: str, run_root: Path) -> AgentController:
    """Compose a controller from the model and environment HTTP endpoints."""
    provider = HttpEnvironmentProvider(HttpEnvironmentConfig.from_env())
    manifest = EnvironmentManifest.from_dict(provider.describe_environment())
    policy = RepairPolicy(manifest)
    return AgentController(
        run_id=run_id,
        client=VLLMNemotronClient(VLLMClientConfig.from_env()),
        tools=EnvironmentTools(provider, manifest),
        evidence=EvidenceLedger(run_root),
        event_log=JsonlEventLog(run_root / "events.jsonl", run_id),
        repair_precheck=RepairPrecheck(policy, provider),
    )


def _result_payload(result: AgentRunResult) -> dict[str, object]:
    payload: dict[str, object] = {
        "run_id": result.run_id,
        "state": result.state,
        "decision": result.decision.to_dict(),
        "steps": result.steps,
        "tool_calls": result.tool_calls,
        "expansion_rounds": result.expansion_rounds,
        "evidence": [item.to_dict() for item in result.evidence],
    }
    if result.precheck is not None:
        payload["precheck"] = result.precheck.to_dict()
    return payload


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Nexus Omega agent")
    parser.add_argument("problem", nargs="?", help="Manual problem description")
    parser.add_argument(
        "--input",
        type=Path,
        help="JSON file containing a structured DiagnosticInput",
    )
    parser.add_argument(
        "--artifact-dir", type=Path, default=Path("artifacts/agent-runs")
    )
    parser.add_argument("--run-id", default="")
    args = parser.parse_args(argv)
    if bool(args.problem) == bool(args.input):
        parser.error("provide exactly one of a problem description or --input")
    if args.input:
        diagnostic_input = DiagnosticInput.from_dict(
            json.loads(args.input.read_text(encoding="utf-8"))
        )
    else:
        diagnostic_input = DiagnosticInput.from_dict(
            {
                "trigger_id": f"manual-{uuid.uuid4().hex[:12]}",
                "summary": args.problem,
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "affected_resources": [],
                "initial_observations": [],
                "human_context": args.problem,
            }
        )
    run_id = args.run_id or f"run-{uuid.uuid4().hex[:12]}"
    run_root = args.artifact_dir / run_id
    result = build_live_controller(run_id, run_root).run(diagnostic_input)
    print(json.dumps(_result_payload(result), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
