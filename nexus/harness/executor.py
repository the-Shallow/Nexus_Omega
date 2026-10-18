"""Mutation executor: the only path by which a solver changes the target fleet.

The agent runtime (after PRECHECK) and the rule baseline both call these
actions. Each one:
  - holds a host-wide lock, so only one mutation is in flight;
  - refuses to remove capacity when no other worker is serving
    (REQUIRES_APPROVAL), so a repair cannot cause an outage;
  - accepts only approved profiles (kind "healthy"), never fault profiles;
  - drains the worker, changes it, checks it with the hidden canary set
    (never shown to the agent), then undrains it or rolls back;
  - after undraining, probes the worker's route through HAProxy: a worker
    that passes on its own port but not on the users' path (a link fault)
    is drained again and handed to a human, never reported VERIFIED;
  - appends an audit record to artifacts/harness/audit.jsonl.

Usage:
    python -m nexus.harness.executor patch_serving_config target-a qwen25-coder-7b.tools-template
    python -m nexus.harness.executor restart_worker target-b
    python -m nexus.harness.executor drain_worker target-b
    python -m nexus.harness.executor undrain_worker target-b
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import sys
import time
import uuid
from pathlib import Path

import httpx

from nexus.harness.inspect import TARGET_WORKERS, HarnessError, effective_launch_config, worker_for
from nexus.target import manager
from nexus.verifier import canary, route

ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = ROOT / "runtime" / "state" / "executor.lock"
AUDIT_PATH = ROOT / "artifacts" / "harness" / "audit.jsonl"
HIDDEN_CASES = ROOT / "runtime" / "canaries" / "hidden.jsonl"
GATEWAY = os.environ.get("NEXUS_GATEWAY_URL", "http://localhost:8100")  # inference (HAProxy)
ADMIN = os.environ.get("NEXUS_ADMIN_URL", "http://localhost:8110")      # drain / weight
ROUTE_CHECK = {"requests": 20, "max_p95_s": 0.5, "max_error_rate": 0.0}


class Busy(RuntimeError):
    pass


@contextlib.contextmanager
def mutation_lock():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Busy("another mutation is in progress") from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def audit(record: dict) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(AUDIT_PATH, "a") as handle:
        handle.write(json.dumps(record) + "\n")


def gateway(method: str, path: str) -> dict:
    headers = {}
    if os.environ.get("NEXUS_ADMIN_TOKEN"):
        headers["authorization"] = f"Bearer {os.environ['NEXUS_ADMIN_TOKEN']}"
    resp = httpx.request(method, f"{ADMIN}{path}", headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()


def other_serving_workers(worker: str) -> list[str]:
    """Workers other than `worker` that are running and receiving traffic."""
    routes = gateway("GET", "/admin/workers")
    running = {row["worker"] for row in manager.status()
               if row["container"] == "running" and row["worker"] in TARGET_WORKERS}
    return [w for w, s in routes.items()
            if w != worker and w in running and not s["drained"] and s["weight"] > 0]


def approved_profile(name: str) -> dict:
    try:
        profile = manager.load_profile(name)
    except SystemExit as exc:
        raise HarnessError(f"unknown profile: {name}") from exc
    if profile.get("kind") != "healthy":
        raise HarnessError(f"profile is not approved for repair: {name}")
    return profile


def hidden_check(worker: str) -> dict:
    state = manager.read_state(worker)
    profile = manager.load_profile(state["profile"])
    model = profile.get("served_model_name", profile["model"])
    result = canary.run(f"http://localhost:{state['port']}", model,
                        canary.load_cases(str(HIDDEN_CASES)), repeat=1, raw=False, no_think=True)
    failed = [r["case"] for rep in result["repeats"] for r in rep if not r["ok"]]
    return {"passed": result["passed"], "health_status": result["health_status"], "failed_cases": failed}


def route_check(worker: str) -> dict:
    """The users' path: this worker's p95 and errors on probes sent through HAProxy."""
    profile = manager.load_profile(manager.read_state(worker)["profile"])
    result = route.run(GATEWAY, profile.get("served_model_name", profile["model"]), ROUTE_CHECK["requests"],
                       ROUTE_CHECK["max_p95_s"], ROUTE_CHECK["max_error_rate"])
    mine = result["workers"].get(worker)
    # No probe reached the worker (e.g. HAProxy marked it down): not shown to serve users.
    return {"passed": bool(mine and mine["ok"]), "worker": mine, "limits": result["limits"]}


def run_action(action: str, service: str, removes_capacity: bool, body) -> dict:
    """Shared envelope: validation, lock, capacity guard, audit."""
    record = {"action": action, "service": service, "change_id": uuid.uuid4().hex[:12],
              "started_at": manager.now()}
    started = time.monotonic()
    try:
        worker = worker_for(service)
        with mutation_lock():
            if removes_capacity and not other_serving_workers(worker):
                record.update(status="REQUIRES_APPROVAL",
                              reason="no other worker is serving; this action would cause an outage")
            else:
                record.update(body(worker, record))
    except Busy as exc:
        record.update(status="REJECTED", reason=str(exc))
    except HarnessError as exc:
        record.update(status="REJECTED", reason=str(exc))
    except Exception as exc:  # noqa: BLE001 - surface any harness failure in the audit trail
        record.update(status="FAILED", reason=f"{type(exc).__name__}: {exc}"[:300])
    record["ended_at"] = manager.now()
    record["seconds"] = round(time.monotonic() - started, 1)
    audit(record)
    return record


def verify_or_rollback(worker: str, undo) -> dict:
    """Hidden check after a change; undrain on pass, otherwise undo and recheck."""
    check = hidden_check(worker)
    if check["passed"]:
        gateway("POST", f"/admin/workers/{worker}/undrain")
        users = route_check(worker)
        if users["passed"]:
            return {"status": "VERIFIED", "verification": check, "route_check": users}
        gateway("POST", f"/admin/workers/{worker}/drain")
        return {"status": "REQUIRES_APPROVAL", "verification": check, "route_check": users,
                "reason": "worker passes on its own port but not through HAProxy; drained again, "
                          "the path to it needs a human"}
    undo()
    recheck = hidden_check(worker)
    if recheck["passed"]:
        gateway("POST", f"/admin/workers/{worker}/undrain")
        return {"status": "ROLLED_BACK", "verification": check, "after_rollback": recheck}
    return {"status": "REQUIRES_APPROVAL", "verification": check, "after_rollback": recheck,
            "reason": "rollback did not restore a passing hidden check; worker left drained"}


def patch_serving_config(service: str, approved_profile_name: str) -> dict:
    def body(worker: str, record: dict) -> dict:
        approved_profile(approved_profile_name)
        record["before"] = effective_launch_config(service)
        gateway("POST", f"/admin/workers/{worker}/drain")
        change = manager.apply(worker, approved_profile_name)
        record["manager_change_id"] = change["change_id"]
        return {"profile": approved_profile_name,
                **verify_or_rollback(worker, lambda: manager.rollback(worker, change["change_id"]))}
    return run_action("patch_serving_config", service, True, body)


def restart_worker(service: str) -> dict:
    def body(worker: str, record: dict) -> dict:
        state = manager.read_state(worker)
        gateway("POST", f"/admin/workers/{worker}/drain")
        waited = manager.launch(worker, state["port"], manager.load_profile(state["profile"]))
        record["ready_seconds"] = round(waited, 1)
        return {"profile": state["profile"], **verify_or_rollback(worker, lambda: None)}
    return run_action("restart_worker", service, True, body)


def drain_worker(service: str) -> dict:
    def body(worker: str, record: dict) -> dict:
        return {"status": "APPLIED", "gateway": gateway("POST", f"/admin/workers/{worker}/drain")}
    return run_action("drain_worker", service, True, body)


def undrain_worker(service: str) -> dict:
    def body(worker: str, record: dict) -> dict:
        return {"status": "APPLIED", "gateway": gateway("POST", f"/admin/workers/{worker}/undrain")}
    return run_action("undrain_worker", service, False, body)


ACTIONS = {
    "patch_serving_config": patch_serving_config,
    "restart_worker": restart_worker,
    "drain_worker": drain_worker,
    "undrain_worker": undrain_worker,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.harness.executor")
    parser.add_argument("action", choices=sorted(ACTIONS))
    parser.add_argument("service")
    parser.add_argument("approved_profile", nargs="?")
    args = parser.parse_args(argv)
    if args.action == "patch_serving_config":
        if not args.approved_profile:
            parser.error("patch_serving_config needs an approved_profile")
        out = patch_serving_config(args.service, args.approved_profile)
    else:
        out = ACTIONS[args.action](args.service)
    print(json.dumps(out, indent=2))
    return 0 if out["status"] in ("VERIFIED", "ROLLED_BACK", "APPLIED") else 1


if __name__ == "__main__":
    sys.exit(main())
