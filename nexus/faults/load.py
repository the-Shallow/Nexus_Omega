"""Load fault injector: keeps a fixed number of requests in flight against one worker.

A detached process (its own session, so it outlives the caller) runs the
preset's client threads straight at the worker's port, like an internal batch
client. On a worker capped at one sequence the requests queue, so it is slow
through HAProxy and when probed directly; a healthy worker batches them. Same
contract as nexus.faults.network: apply returns a change_id, rollback(change_id)
stops it, and only named presets exist.

Usage:
    python -m nexus.faults.load apply b steady
    python -m nexus.faults.load rollback b <change_id>
    python -m nexus.faults.load clear
    python -m nexus.faults.load status
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import httpx

from nexus.target import manager

ROOT = Path(__file__).resolve().parents[2]
# Kept out of runtime/state/*.json, which the manager reads as worker state.
STATE_PATH = ROOT / "runtime" / "state" / "faults" / "load.json"
MODEL = "qwen25-coder"

PRESETS = {
    "steady": {"concurrency": 4, "max_tokens": 128},
}


def read_state() -> dict:
    return json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {"history": [], "active": {}}


def write_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def apply(worker: str, preset: str) -> dict:
    if preset not in PRESETS:
        raise SystemExit(f"unknown preset '{preset}'; choose from {sorted(PRESETS)}")
    worker_state = manager.read_state(worker)
    if worker_state is None:
        raise SystemExit(f"worker '{worker}' has no state; run 'manager up' first")
    proc = subprocess.Popen([sys.executable, "-m", "nexus.faults.load", "_run", str(worker_state["port"]), preset],
                            cwd=ROOT, start_new_session=True, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    change = {"change_id": uuid.uuid4().hex[:12], "worker": worker, "preset": preset, "pid": proc.pid,
              "port": worker_state["port"], "applied_at": manager.now()}
    state = read_state()
    state["history"].append(change)
    state["active"][change["change_id"]] = proc.pid
    write_state(state)
    return change


def stop(pid: int) -> None:
    if alive(pid):
        os.killpg(pid, signal.SIGTERM)


def rollback(worker: str, change_id: str) -> dict:
    change = next((c for c in read_state()["history"]
                   if c["change_id"] == change_id and c["worker"] == worker), None)
    if change is None:
        raise SystemExit(f"unknown change_id '{change_id}' for worker '{worker}'")
    stop(change["pid"])
    state = read_state()
    state["active"].pop(change_id, None)
    write_state(state)
    return {"rolled_back": change_id, "worker": worker, "stopped_pid": change["pid"]}


def clear() -> dict:
    state = read_state()
    stopped = []
    for change_id, pid in list(state["active"].items()):
        stop(pid)
        stopped.append(pid)
        state["active"].pop(change_id)
    write_state(state)
    return {"stopped_pids": stopped}


def status() -> dict:
    return {change_id: {"pid": pid, "alive": alive(pid)} for change_id, pid in read_state()["active"].items()}


def run(port: int, preset: str) -> None:
    """Client loop of the detached process; runs until SIGTERM."""
    spec = PRESETS[preset]
    body = {"model": MODEL, "max_tokens": spec["max_tokens"], "temperature": 0, "ignore_eos": True,
            "messages": [{"role": "user", "content": "Write a long story about a lighthouse keeper."}]}

    def client() -> None:
        with httpx.Client(timeout=300) as http:
            while True:
                try:
                    http.post(f"http://localhost:{port}/v1/chat/completions", json=body)
                except httpx.HTTPError:
                    threading.Event().wait(1)

    for _ in range(spec["concurrency"]):
        threading.Thread(target=client, daemon=True).start()
    threading.Event().wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.faults.load")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_apply = sub.add_parser("apply")
    p_apply.add_argument("worker")
    p_apply.add_argument("preset", choices=sorted(PRESETS))
    p_rb = sub.add_parser("rollback")
    p_rb.add_argument("worker")
    p_rb.add_argument("change_id")
    sub.add_parser("clear")
    sub.add_parser("status")
    p_run = sub.add_parser("_run")
    p_run.add_argument("port", type=int)
    p_run.add_argument("preset", choices=sorted(PRESETS))

    args = parser.parse_args(argv)
    if args.cmd == "_run":
        run(args.port, args.preset)
        return 0
    if args.cmd == "apply":
        out = apply(args.worker, args.preset)
    elif args.cmd == "rollback":
        out = rollback(args.worker, args.change_id)
    elif args.cmd == "clear":
        out = clear()
    else:
        out = status()
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
