"""Rule baseline: a fixed symptom-to-action playbook, the solver Nemotron must beat.

It observes through the harness (container state, per-worker health and
latency, the visible canary, gateway route probe) and acts only through
nexus.harness.executor, the same action path the agent uses. Rules are tried
in order and the first match acts:

  1. a worker's container is not running         -> restart_worker
  2. a route breaches the SLO at the gateway while
     the worker itself answers quickly direct     -> drain_worker (link fault;
                                                    needs a human, REQUIRES_APPROVAL)
  3. visible canary: HTTP 200, zero tool calls,
     call-shaped JSON in the content              -> patch_serving_config(healthy profile)
  4. visible canary: HTTP 4xx/5xx                 -> patch_serving_config(healthy profile)
  5. nothing matched                              -> ABSTAIN

The decision follows schemas/agent-decision.schema.json.

Usage:
    python -m nexus.baseline.rules
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time

import httpx

from nexus.harness import executor
from nexus.target import manager
from nexus.verifier import canary, route

GATEWAY = executor.GATEWAY
MODEL = "qwen25-coder"
ROUTE_LIMITS = {"max_p95_s": 0.5, "max_error_rate": 0.0}
CALL_SHAPED = re.compile(r'"name"\s*:\s*"[^"]+"[\s\S]*"arguments"\s*:')


def healthy_profile_for(profile_name: str) -> str | None:
    model = manager.load_profile(profile_name)["model"]
    for path in sorted(manager.PROFILES_DIR.glob("*.json")):
        candidate = json.loads(path.read_text())
        if candidate.get("kind") == "healthy" and candidate.get("model") == model:
            return path.stem
    return None


def direct_probe(port: int) -> dict:
    base = f"http://localhost:{port}"
    body = {"model": MODEL, "messages": [{"role": "user", "content": "Reply with the word ok."}],
            "max_tokens": 8, "temperature": 0}
    with httpx.Client(timeout=15) as client:
        try:
            health = client.get(f"{base}/health").status_code
            started = time.monotonic()
            status = client.post(f"{base}/v1/chat/completions", json=body).status_code
            return {"health": health, "status": status, "latency_s": round(time.monotonic() - started, 3)}
        except httpx.HTTPError as exc:
            return {"health": 0, "status": 0, "error": type(exc).__name__}


def visible_canary(port: int) -> dict:
    case = next(c for c in canary.BUILTIN_CASES if c["name"] == "single_call")
    with httpx.Client(timeout=120) as client:
        return canary.run_case(client, f"http://localhost:{port}", MODEL, case, raw=False, no_think=True)


def observe() -> dict:
    workers = {}
    for row in manager.status():
        state = manager.read_state(row["worker"])
        entry = {"container": row["container"], "profile": row["profile"], "port": state["port"]}
        if row["container"] == "running":
            entry["direct"] = direct_probe(state["port"])
            entry["canary"] = visible_canary(state["port"])
        workers[row["worker"]] = entry
    routes = route.run(GATEWAY, MODEL, 20, ROUTE_LIMITS["max_p95_s"], ROUTE_LIMITS["max_error_rate"])
    return {"workers": workers, "routes": routes["workers"]}


def decide(obs: dict) -> tuple[str, dict, str]:
    """Return (rule id, action, evidence summary); action is {} for ABSTAIN."""
    for worker, w in obs["workers"].items():
        if w["container"] != "running":
            return "worker_down", {"tool": "restart_worker", "service": f"target-{worker}"}, \
                f"container for worker {worker} is {w['container']}"
    for worker, r in obs["routes"].items():
        w = obs["workers"].get(worker, {})
        direct = w.get("direct", {})
        if not r["ok"] and direct.get("status") == 200 and direct.get("latency_s", 99) < ROUTE_LIMITS["max_p95_s"]:
            return "link_fault", {"tool": "drain_worker", "service": f"target-{worker}"}, \
                f"route {worker} p95={r['p95_s']}s errors={r['error_rate']:.0%} but direct latency {direct['latency_s']}s"
    for worker, w in obs["workers"].items():
        result = w.get("canary")
        if not result or result["ok"]:
            continue
        target = healthy_profile_for(w["profile"])
        action = {"tool": "patch_serving_config", "service": f"target-{worker}", "approved_profile": target}
        if result["http_status"] == 200 and not result["tool_calls"] and CALL_SHAPED.search(result["content"] or ""):
            return "parser_mismatch", action, f"worker {worker}: HTTP 200, 0 tool calls, call-shaped JSON in content"
        if result["http_status"] >= 400:
            return "serving_error", action, f"worker {worker}: canary HTTP {result['http_status']}"
    return "no_match", {}, "no rule matched the observed symptoms"


def act(action: dict) -> dict:
    if action["tool"] == "patch_serving_config":
        return executor.patch_serving_config(action["service"], action["approved_profile"])
    return executor.ACTIONS[action["tool"]](action["service"])


def solve() -> dict:
    started = time.monotonic()
    obs = observe()
    rule, action, evidence = decide(obs)
    record = act(action) if action else None
    if not action:
        state, stop = "ABSTAIN", "no rule matched"
    elif rule == "link_fault" and record["status"] == "APPLIED":
        state, stop = "REQUIRES_APPROVAL", "traffic drained from the impaired route; the link needs a human"
    elif record["status"] in ("VERIFIED", "ROLLED_BACK", "REQUIRES_APPROVAL"):
        state, stop = record["status"], record.get("reason") or f"executor returned {record['status']}"
    else:
        state, stop = "REQUIRES_APPROVAL", f"executor returned {record['status']}: {record.get('reason')}"
    return {
        "decision": {"state": state, "summary": f"rule {rule}: {evidence}",
                     "hypotheses": [{"id": rule, "confidence": 1.0, "supports": [evidence], "contradicts": []}],
                     "stop_reason": stop},
        "rule": rule, "action": action, "executor": record, "observation": obs,
        "seconds": round(time.monotonic() - started, 1),
    }


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(prog="nexus.baseline.rules").parse_args(argv)
    out = solve()
    print(json.dumps({k: out[k] for k in ("decision", "rule", "action", "seconds")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
