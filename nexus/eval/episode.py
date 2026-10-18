"""Episode runner: reset -> inject -> solver -> independent verification -> record.

The solver only sees the broken fleet. Afterwards the runner checks, on its
own, whether users are served (gateway route probe + hidden canary through the
gateway) and whether the root cause is gone. Link faults cannot be fixed by a
software solver, so the expected outcome there is mitigation (traffic drained,
users served) with a REQUIRES_APPROVAL terminal state.

Usage:
    python -m nexus.eval.episode vllm-32926 --solver rules
    python -m nexus.eval.episode all --solver rules --repeat 3
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from nexus.baseline import rules
from nexus.faults import network, process
from nexus.harness import executor
from nexus.target import manager
from nexus.verifier import canary, route

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts" / "episodes"
HEALTHY = "qwen25-coder-7b.tools-template"
WORKERS = {"a": 8101, "b": 8102}

FAULTS = {
    "vllm-32926": {"worker": "a", "fixable": True,
                   "inject": lambda: manager.apply("a", "qwen25-coder-7b.vllm-32926")},
    "net-latency-b": {"worker": "b", "fixable": False, "inject": lambda: network.apply("b", "latency")},
    "net-blackhole-b": {"worker": "b", "fixable": False, "inject": lambda: network.apply("b", "blackhole")},
    "kill-b": {"worker": "b", "fixable": True, "inject": lambda: process.apply("b", "kill")},
}
def agent_solver() -> dict:
    from nexus.harness import agent_run  # imported lazily: needs the NEMOTRON_* / NEXUS_ENVIRONMENT_* settings
    return agent_run.run_agent()


SOLVERS = {"rules": rules.solve, "agent": agent_solver}


def reset() -> None:
    """Both workers on the healthy profile, serving, with no network toxics."""
    network.clear("b")
    for worker, port in WORKERS.items():
        state = manager.read_state(worker)
        running = any(r["worker"] == worker and r["container"] == "running" for r in manager.status())
        if not running or state["profile"] != HEALTHY:
            manager.up(worker, HEALTHY, port)
        executor.gateway("POST", f"/admin/workers/{worker}/undrain")


def verify(fault: dict) -> dict:
    routes = route.run(executor.GATEWAY, rules.MODEL, 30, rules.ROUTE_LIMITS["max_p95_s"],
                       rules.ROUTE_LIMITS["max_error_rate"])
    hidden = canary.run(executor.GATEWAY, rules.MODEL, canary.load_cases(str(executor.HIDDEN_CASES)),
                        repeat=1, raw=False, no_think=True)
    worker = fault["worker"]
    running = any(r["worker"] == worker and r["container"] == "running" for r in manager.status())
    root = running and executor.hidden_check(worker)["passed"] if fault["fixable"] else False
    drained = executor.gateway("GET", "/admin/workers")[worker]["drained"]
    return {"users_ok": routes["passed"] and hidden["passed"], "route": routes["workers"],
            "hidden_passed": hidden["passed"], "root_fixed": root, "faulty_worker_drained": drained}


def run_episode(name: str, solver: str) -> dict:
    fault = FAULTS[name]
    reset()
    fault["inject"]()
    started = time.monotonic()
    result = SOLVERS[solver]()
    solve_seconds = round(time.monotonic() - started, 1)
    check = verify(fault)
    state = result["decision"]["state"]
    if fault["fixable"]:
        success = check["users_ok"] and check["root_fixed"]
    else:
        success = check["users_ok"] and check["faulty_worker_drained"] and state == "REQUIRES_APPROVAL"
    record = {
        "fault": name, "solver": solver, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "terminal_state": state, "success": success,
        "false_verified": state == "VERIFIED" and not (check["users_ok"] and check["root_fixed"]),
        "solve_seconds": solve_seconds, "action": result.get("action"), "rule": result.get("rule"),
        "run_id": result.get("run_id"), "steps": result.get("steps"), "tool_calls": result.get("tool_calls"),
        "decision": result["decision"], "verification": check, "executor": result.get("executor"),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{record['at'].replace(':', '')}-{name}-{solver}.json"
    path.write_text(json.dumps(record, indent=2) + "\n")
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.eval.episode")
    parser.add_argument("fault", choices=[*FAULTS, "all"])
    parser.add_argument("--solver", choices=sorted(SOLVERS), default="rules")
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args(argv)
    names = list(FAULTS) if args.fault == "all" else [args.fault]
    records = []
    try:
        for _ in range(args.repeat):
            for name in names:
                r = run_episode(name, args.solver)
                records.append(r)
                print(f"{name:16} {args.solver:6} state={r['terminal_state']:17} success={r['success']!s:5} "
                      f"false_verified={r['false_verified']!s:5} action={(r['action'] or {}).get('tool')} "
                      f"solve={r['solve_seconds']}s")
    finally:
        reset()
    ok = sum(r["success"] for r in records)
    print(f"summary: {ok}/{len(records)} succeeded, "
          f"{sum(r['false_verified'] for r in records)} false VERIFIED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
