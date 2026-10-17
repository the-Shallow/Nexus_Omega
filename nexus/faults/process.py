"""Process fault injector: crashes a target worker's container.

Same contract as nexus.faults.network: apply returns a change_id and
rollback(change_id) restores the worker with the profile it was running,
through nexus.target.manager. Only named presets exist.

Usage:
    python -m nexus.faults.process apply b kill
    python -m nexus.faults.process rollback b <change_id>
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

from nexus.target import manager

ROOT = Path(__file__).resolve().parents[2]
STATE_PATH = ROOT / "runtime" / "state" / "process-faults.json"

PRESETS = {
    "kill": ["kill", "--signal", "KILL"],
}


def read_state() -> dict:
    return json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {"history": []}


def write_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))


def apply(worker: str, preset: str) -> dict:
    worker_state = manager.read_state(worker)
    if worker_state is None:
        raise SystemExit(f"worker '{worker}' has no state; run 'manager up' first")
    manager.docker(*PRESETS[preset], manager.container_name(worker))
    change = {"change_id": uuid.uuid4().hex[:12], "worker": worker, "preset": preset,
              "profile": worker_state["profile"], "port": worker_state["port"],
              "applied_at": manager.now()}
    state = read_state()
    state["history"].append(change)
    write_state(state)
    return change


def rollback(worker: str, change_id: str) -> dict:
    change = next((c for c in read_state()["history"]
                   if c["change_id"] == change_id and c["worker"] == worker), None)
    if change is None:
        raise SystemExit(f"unknown change_id '{change_id}' for worker '{worker}'")
    waited = manager.launch(worker, change["port"], manager.load_profile(change["profile"]))
    return {"rolled_back": change_id, "worker": worker, "profile": change["profile"],
            "ready_seconds": round(waited, 1)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.faults.process")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_apply = sub.add_parser("apply")
    p_apply.add_argument("worker")
    p_apply.add_argument("preset", choices=sorted(PRESETS))
    p_rb = sub.add_parser("rollback")
    p_rb.add_argument("worker")
    p_rb.add_argument("change_id")

    args = parser.parse_args(argv)
    out = apply(args.worker, args.preset) if args.cmd == "apply" else rollback(args.worker, args.change_id)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
