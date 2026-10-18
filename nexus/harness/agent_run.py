"""Run Nemotron on the live fleet: E1's controller + the Brev environment API + the executor.

The trigger is a monitoring snapshot taken through the environment API (route
probe through HAProxy, visible tool-call canary on each worker), the same
signals the rule baseline starts from, with no hint about the fault. The
controller investigates through its manifest-built tools and stops at
PRECHECK when it proposes an approved action. This runner then applies that
action with POST /actions/{id}/apply (executor token) and reports the
executor's verdict as the terminal state.

Needs NEMOTRON_BASE_URL, NEMOTRON_MODEL, NEXUS_ENVIRONMENT_URL,
NEXUS_ENVIRONMENT_API_KEY and NEXUS_EXECUTOR_TOKEN.

Usage:
    python -m nexus.harness.agent_run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

from nexus.agent.contracts import DiagnosticInput
from nexus.app import build_live_controller
from nexus.infrastructure.target import HttpEnvironmentConfig, HttpEnvironmentProvider

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "artifacts" / "agent-runs"
RESOURCES = ("target-a", "target-b")
SUMMARY = ("Routine fleet health check of the inference service. Review the attached monitoring "
           "snapshot, investigate anything abnormal with the available tools, and repair it if a "
           "declared action is supported by evidence.")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def monitoring_snapshot(provider: HttpEnvironmentProvider) -> list[dict]:
    observations = []
    routes = provider.run_probe("route-probe", {"requests": 10})
    observations.append({
        "source_type": "probe_result", "source": f"probe:route-probe:{routes['observation_id']}",
        "finding": "Per-worker latency and errors through the HAProxy entry point.",
        "content": routes, "trust": "trusted", "observed_at": now(),
    })
    for resource_id in RESOURCES:
        probe = provider.run_probe("tool-call-visible", {"case": "visible_tool_call", "resource_id": resource_id})
        observations.append({
            "source_type": "probe_result", "source": f"probe:tool-call-visible:{probe['artifact_id']}",
            "finding": f"Visible tool-call canary on {resource_id}.",
            "content": probe, "trust": "trusted", "resource_id": resource_id, "observed_at": now(),
        })
    return observations


def apply(approval) -> dict:
    url = os.environ["NEXUS_ENVIRONMENT_URL"].rstrip("/")
    resp = httpx.post(f"{url}/actions/{approval.action_id}/apply", timeout=900,
                      headers={"Authorization": f"Bearer {os.environ['NEXUS_EXECUTOR_TOKEN']}"},
                      json={"target": approval.target, "parameters": approval.parameters,
                            "change_id": approval.change_id})
    resp.raise_for_status()
    return resp.json()["executor"]


def terminal_state(action_id: str, record: dict) -> str:
    status = record.get("status")
    if action_id == "drain-worker" and status == "APPLIED":
        return "REQUIRES_APPROVAL"  # traffic moved off the worker; the cause still needs a human
    if status in ("VERIFIED", "ROLLED_BACK"):
        return status
    return "REQUIRES_APPROVAL"


def run_agent() -> dict:
    run_id = f"run-{uuid.uuid4().hex[:8]}"
    started = time.monotonic()
    provider = HttpEnvironmentProvider(HttpEnvironmentConfig.from_env())
    observations = monitoring_snapshot(provider)
    diagnostic_input = DiagnosticInput.from_dict({
        "trigger_id": f"health-check-{run_id}", "summary": SUMMARY, "observed_at": now(),
        "affected_resources": list(RESOURCES), "initial_observations": observations,
        "human_context": None, "time_window": "10m", "correlation_ids": {},
    })
    action, record = {}, None
    try:
        result = build_live_controller(run_id, RUNS / run_id).run(diagnostic_input)
    except Exception as exc:  # noqa: BLE001 - a failed run is a result for the referee
        decision = {"state": "ABSTAIN", "summary": f"agent run failed: {type(exc).__name__}: {exc}"[:400],
                    "hypotheses": [], "stop_reason": "agent_error"}
        return {"decision": decision, "action": action, "executor": None, "run_id": run_id,
                "seconds": round(time.monotonic() - started, 1), "steps": None, "tool_calls": None}

    decision = result.decision.to_dict()
    state = result.state
    approval = result.precheck.approval if result.precheck else None
    if state == "PRECHECK" and approval is not None:
        action = {"tool": approval.action_id, "service": approval.target, **approval.parameters}
        record = apply(approval)
        state = terminal_state(approval.action_id, record)
    decision["state"] = state
    return {"decision": decision, "action": action, "executor": record, "run_id": run_id,
            "seconds": round(time.monotonic() - started, 1), "steps": result.steps,
            "tool_calls": result.tool_calls, "evidence": len(result.evidence)}


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(prog="nexus.harness.agent_run").parse_args(argv)
    out = run_agent()
    print(json.dumps({k: out.get(k) for k in ("run_id", "decision", "action", "seconds", "steps", "tool_calls")},
                     indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
