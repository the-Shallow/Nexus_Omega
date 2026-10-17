"""Network fault injector: adds and removes Toxiproxy toxics on a worker's link.

The gateway reaches worker b through the Toxiproxy proxy "b" (see
runtime/compose/toxiproxy.json), so a toxic here impairs only that route while
the worker itself stays healthy. Faults are named presets, never free-form
parameters. Same contract as nexus.target.manager: apply returns a change_id,
rollback(change_id) undoes it.

Usage:
    python -m nexus.faults.network apply b latency
    python -m nexus.faults.network rollback b <change_id>
    python -m nexus.faults.network status
    python -m nexus.faults.network clear b
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
# Kept out of runtime/state/*.json, which the manager reads as worker state.
STATE_PATH = ROOT / "runtime" / "state" / "faults" / "network.json"
API = os.environ.get("NEXUS_TOXIPROXY_API", "http://localhost:8474")

PRESETS = {
    "latency": {"type": "latency", "stream": "downstream", "toxicity": 1.0,
                "attributes": {"latency": 1500, "jitter": 200}},
    "blackhole": {"type": "timeout", "stream": "upstream", "toxicity": 1.0,
                  "attributes": {"timeout": 5000}},
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_state() -> dict:
    return json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {"history": []}


def write_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))


def toxics(proxy: str) -> list[dict]:
    resp = httpx.get(f"{API}/proxies/{proxy}/toxics", timeout=5)
    resp.raise_for_status()
    return resp.json()


def apply(proxy: str, preset: str) -> dict:
    if preset not in PRESETS:
        raise SystemExit(f"unknown preset '{preset}'; choose from {sorted(PRESETS)}")
    change_id = uuid.uuid4().hex[:12]
    body = {"name": f"{preset}-{change_id}", **PRESETS[preset]}
    resp = httpx.post(f"{API}/proxies/{proxy}/toxics", json=body, timeout=5)
    resp.raise_for_status()
    change = {"change_id": change_id, "proxy": proxy, "preset": preset,
              "toxic": body["name"], "applied_at": now()}
    state = read_state()
    state["history"].append(change)
    write_state(state)
    return change


def rollback(proxy: str, change_id: str) -> dict:
    change = next((c for c in read_state()["history"]
                   if c["change_id"] == change_id and c["proxy"] == proxy), None)
    if change is None:
        raise SystemExit(f"unknown change_id '{change_id}' for proxy '{proxy}'")
    resp = httpx.delete(f"{API}/proxies/{proxy}/toxics/{change['toxic']}", timeout=5)
    if resp.status_code not in (204, 404):
        resp.raise_for_status()
    return {"rolled_back": change_id, "proxy": proxy, "removed": change["toxic"],
            "active_toxics": [t["name"] for t in toxics(proxy)]}


def clear(proxy: str) -> dict:
    removed = []
    for toxic in toxics(proxy):
        httpx.delete(f"{API}/proxies/{proxy}/toxics/{toxic['name']}", timeout=5).raise_for_status()
        removed.append(toxic["name"])
    return {"proxy": proxy, "removed": removed}


def status() -> dict:
    resp = httpx.get(f"{API}/proxies", timeout=5)
    resp.raise_for_status()
    return {name: {"upstream": p["upstream"], "enabled": p["enabled"],
                   "toxics": [t["name"] for t in p["toxics"]]}
            for name, p in resp.json().items()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.faults.network")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_apply = sub.add_parser("apply")
    p_apply.add_argument("proxy")
    p_apply.add_argument("preset", choices=sorted(PRESETS))
    p_rb = sub.add_parser("rollback")
    p_rb.add_argument("proxy")
    p_rb.add_argument("change_id")
    p_clear = sub.add_parser("clear")
    p_clear.add_argument("proxy")
    sub.add_parser("status")

    args = parser.parse_args(argv)
    if args.cmd == "apply":
        out = apply(args.proxy, args.preset)
    elif args.cmd == "rollback":
        out = rollback(args.proxy, args.change_id)
    elif args.cmd == "clear":
        out = clear(args.proxy)
    else:
        out = status()
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
