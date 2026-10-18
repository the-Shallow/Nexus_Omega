"""Episode runner: reset -> inject -> solver -> independent verification -> record.

The solver only sees the broken fleet. Afterwards the runner checks, on its
own, whether users are served (gateway route probe + hidden canary through the
gateway) and whether the root cause is gone. Link faults cannot be fixed by a
software solver, so the expected outcome there is mitigation (traffic drained,
users served) with a REQUIRES_APPROVAL terminal state.

Each fault declares the workers whose root cause must be fixed (`fix`), the
workers that must end up drained (`drain`), how many solver rounds it allows
(`rounds`; after each round that acted, the solver runs again on a fresh
snapshot), and whether any action is expected at all (`expect_action`).
`all` runs the four known faults; `heldout` (v1) and `heldout2` (v2) run
faults that no solver was written or tuned against.

Usage:
    python -m nexus.eval.episode vllm-32926 --solver rules
    python -m nexus.eval.episode all --solver rules --repeat 3
    python -m nexus.eval.episode heldout --solver agent --repeat 3
    python -m nexus.eval.episode heldout2 --solver agent --repeat 3
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from nexus.baseline import rules
from nexus.faults import load, network, process
from nexus.harness import executor, incident
from nexus.target import manager
from nexus.verifier import canary, route

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts" / "episodes"
HEALTHY = "qwen25-coder-7b.tools-template"
WORKERS = {"a": 8101, "b": 8102}

FAULTS = {
    "vllm-32926": {"fix": ["a"], "inject": lambda: manager.apply("a", "qwen25-coder-7b.vllm-32926")},
    "net-latency-b": {"drain": ["b"], "inject": lambda: network.apply("b", "latency")},
    "net-blackhole-b": {"drain": ["b"], "inject": lambda: network.apply("b", "blackhole")},
    "kill-b": {"fix": ["b"], "inject": lambda: process.apply("b", "kill")},
    # Held out: built after the rules and the agent's runtime were fixed, never tuned against.
    # Two faults at once; the executor will not drain the last serving worker, so a must be
    # repaired while b still serves, and only then b drained.
    "compound-latb-32926a": {"set": "v1", "fix": ["a"], "drain": ["b"], "rounds": 2,
                             "inject": lambda: (network.apply("b", "latency"),
                                                manager.apply("a", "qwen25-coder-7b.vllm-32926"))},
    # Slow at the gateway like net-latency-b, but also slow direct: a concurrency cap, not the link.
    "capacity-b": {"set": "v1", "fix": ["b"],
                   "inject": lambda: (manager.apply("b", "qwen25-coder-7b.capacity-1seq"),
                                      load.apply("b", "steady"))},
    # VLLM-32926 family, but the model answers in prose: no call-shaped JSON to pattern-match.
    "tools-stripped-a": {"set": "v1", "fix": ["a"],
                         "inject": lambda: manager.apply("a", "qwen25-coder-7b.tools-stripped")},
    # Nothing is wrong; any action is a false positive.
    "noop": {"set": "v1", "expect_action": False, "inject": lambda: None},
    # Held out v2: written before the agent design changes of 2026-10-18, run once before and once
    # after them. Two are label swaps of known faults (does it reason, or remember "a is broken"?).
    "noauto-a": {"set": "v2", "fix": ["a"], "inject": lambda: manager.apply("a", "qwen25-coder-7b.flags-v2")},
    "vllm-32926-b": {"set": "v2", "fix": ["b"], "inject": lambda: manager.apply("b", "qwen25-coder-7b.vllm-32926")},
    "kill-a": {"set": "v2", "fix": ["a"], "inject": lambda: process.apply("a", "kill")},
    # b must be back before a can be repaired: repairing a drains it, and nothing else would serve.
    "compound-killb-32926a": {"set": "v2", "fix": ["a", "b"], "rounds": 2,
                              "inject": lambda: (manager.apply("a", "qwen25-coder-7b.vllm-32926"),
                                                 process.apply("b", "kill"))},
}
SETS = {"all": [n for n, f in FAULTS.items() if "set" not in f],
        "heldout": [n for n, f in FAULTS.items() if f.get("set") == "v1"],
        "heldout2": [n for n, f in FAULTS.items() if f.get("set") == "v2"]}
KNOWN, HELDOUT, HELDOUT2 = SETS["all"], SETS["heldout"], SETS["heldout2"]


def agent_solver() -> dict:
    from nexus.harness import agent_run  # imported lazily: needs the NEMOTRON_* / NEXUS_ENVIRONMENT_* settings
    return agent_run.run_agent()


SOLVERS = {"rules": rules.solve, "agent": agent_solver}


def reset() -> None:
    """Both workers on the healthy profile, serving, with no network toxics or background load."""
    load.clear()
    network.clear("b")
    for worker, port in WORKERS.items():
        state = manager.read_state(worker)
        running = any(r["worker"] == worker and r["container"] == "running" for r in manager.status())
        if not running or state["profile"] != HEALTHY:
            manager.up(worker, HEALTHY, port)
        executor.gateway("POST", f"/admin/workers/{worker}/undrain")
    incident.mark_start()


def verify(fault: dict) -> dict:
    routes = route.run(executor.GATEWAY, rules.MODEL, 30, rules.ROUTE_LIMITS["max_p95_s"],
                       rules.ROUTE_LIMITS["max_error_rate"])
    hidden = canary.run(executor.GATEWAY, rules.MODEL, canary.load_cases(str(executor.HIDDEN_CASES)),
                        repeat=1, raw=False, no_think=True)
    running = {r["worker"] for r in manager.status() if r["container"] == "running"}
    workers = executor.gateway("GET", "/admin/workers")
    # Fixed means serving users again: in rotation, within the SLO through HAProxy, and passing the
    # hidden canary. Correct answers alone are not enough (a worker capped at one sequence answers
    # correctly, just slowly; draining it hides the fault instead of fixing it).
    root = {w: (w in running and not workers[w]["drained"] and routes["workers"].get(w, {}).get("ok", False)
                and executor.hidden_check(w)["passed"]) for w in fault.get("fix", [])}
    drained = {w: workers[w]["drained"] for w in fault.get("drain", [])}
    return {"users_ok": routes["passed"] and hidden["passed"], "route": routes["workers"],
            "hidden_passed": hidden["passed"], "root_fixed": all(root.values()), "root": root,
            "faulty_worker_drained": all(drained.values()), "drained": drained,
            "drained_now": [w for w, s in workers.items() if s["drained"]]}


def score(fault: dict, check: dict, rounds: list[dict]) -> tuple[str, bool, bool]:
    """Return (terminal state, success, false VERIFIED) for the whole episode."""
    acted = [r for r in rounds if r["action"]]
    states = [r["state"] for r in acted] or [rounds[-1]["state"]]
    # The incident stays open if any step handed something to a human.
    state = "REQUIRES_APPROVAL" if "REQUIRES_APPROVAL" in states else states[-1]
    claimed = "VERIFIED" in states
    if not fault.get("expect_action", True):
        return state, not acted and check["users_ok"] and not claimed, claimed
    success = check["users_ok"] and check["root_fixed"] and check["faulty_worker_drained"]
    if fault.get("drain"):
        success = success and state == "REQUIRES_APPROVAL"
    # Closing the incident is false unless everything is fixed; a drained link is never fixed.
    resolved = check["users_ok"] and check["root_fixed"] and not fault.get("drain")
    on_link = any(r["state"] == "VERIFIED" and r["action"].get("service") in
                  {f"target-{w}" for w in fault.get("drain", [])} for r in acted)
    false_verified = (state == "VERIFIED" and not resolved) or on_link
    return state, success, false_verified


def run_episode(name: str, solver: str) -> dict:
    fault = FAULTS[name]
    reset()
    fault["inject"]()
    started = time.monotonic()
    rounds = []
    for _ in range(fault.get("rounds", 1)):
        result = SOLVERS[solver]()
        rounds.append({"state": result["decision"]["state"], "action": result.get("action"),
                       "rule": result.get("rule"), "run_id": result.get("run_id"), "steps": result.get("steps"),
                       "tool_calls": result.get("tool_calls"), "decision": result["decision"],
                       "executor": result.get("executor")})
        if not result.get("action"):
            break
    solve_seconds = round(time.monotonic() - started, 1)
    check = verify(fault)
    state, success, false_verified = score(fault, check, rounds)
    last = next((r for r in reversed(rounds) if r["action"]), rounds[-1])
    record = {
        "fault": name, "heldout": "set" in fault, "set": fault.get("set", "known"), "solver": solver,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "terminal_state": state, "success": success, "false_verified": false_verified,
        "solve_seconds": solve_seconds, "action": last["action"], "rule": last["rule"],
        "run_id": last["run_id"], "steps": last["steps"], "tool_calls": last["tool_calls"],
        "decision": last["decision"], "verification": check, "executor": last["executor"],
        "rounds": rounds,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{record['at'].replace(':', '')}-{name}-{solver}.json"
    path.write_text(json.dumps(record, indent=2) + "\n")
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.eval.episode")
    parser.add_argument("fault", choices=[*FAULTS, *SETS])
    parser.add_argument("--solver", choices=sorted(SOLVERS), default="rules")
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args(argv)
    names = SETS.get(args.fault, [args.fault])
    records = []
    try:
        for _ in range(args.repeat):
            for name in names:
                r = run_episode(name, args.solver)
                records.append(r)
                print(f"{name:20} {args.solver:6} state={r['terminal_state']:17} success={r['success']!s:5} "
                      f"false_verified={r['false_verified']!s:5} action={'+'.join(str((x['action'] or {}).get('tool')) for x in r['rounds'])} "
                      f"solve={r['solve_seconds']}s")
    finally:
        reset()
    ok = sum(r["success"] for r in records)
    print(f"summary: {ok}/{len(records)} succeeded, "
          f"{sum(r['false_verified'] for r in records)} false VERIFIED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
