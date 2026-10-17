"""Bounded remediation actions on the twin, mirroring the Nexus act tools.

Each action records the state it replaced so it can be rolled back. Restarts
cannot be undone and are marked ``reversible: False``.
"""

from __future__ import annotations

from .model import Twin, Worker

KINDS = (
    "restart_worker",
    "drain_worker",
    "set_route_weight",
    "set_concurrency",
    "throttle",
    "patch_config",
    "set_power_limit",
    "pause_batch",
    "resume_batch",
    "cordon_node",
    "uncordon_node",
)


def _worker(twin: Twin, wid: str) -> Worker:
    if wid not in twin.state.workers:
        raise ValueError(f"unknown worker: {wid}")
    return twin.state.workers[wid]


def _scope_nodes(twin: Twin, scope: str) -> list[str]:
    """Resolve a node / rack / row / 'batch' / 'batch:<row>' scope to node ids."""
    s = twin.state
    if scope in s.nodes:
        return [scope]
    if scope in s.racks:
        return list(s.racks[scope].nodes)
    role, _, row = scope.partition(":") if scope.startswith("batch") else ("", "", scope)
    if role == "batch":
        return [n.id for n in s.nodes.values() if n.role == "batch" and (not row or s.racks[n.rack].row == row)]
    if row in twin.profile["hall"]["rows"]:
        return [n.id for n in s.nodes.values() if s.racks[n.rack].row == row]
    raise ValueError(f"unknown scope: {scope}")


def apply_action(twin: Twin, kind: str, args: dict | None = None, quiet: bool = False) -> dict:
    args = args or {}
    s = twin.state
    before: dict = {}
    reversible = True
    if kind == "restart_worker":
        w = _worker(twin, args["worker"])
        twin.restart(w, readmit=bool(args.get("readmit")))
        reversible = False
    elif kind in ("drain_worker", "set_route_weight"):
        w = _worker(twin, args["worker"])
        before = {"weight": {w.id: w.weight}}
        w.weight = 0.0 if kind == "drain_worker" else float(args.get("weight", 1.0))
        if kind == "drain_worker" and w.state == "hung":
            twin.fail_inflight(w, "timeout")  # stuck requests are released by the client timeout
    elif kind == "set_concurrency":
        targets = [_worker(twin, args["worker"])] if args.get("worker") else list(s.workers.values())
        before = {"cap": {w.id: w.cap for w in targets}}
        for w in targets:
            w.cap = int(args["limit"]) if args.get("limit") else None
    elif kind == "throttle":
        before = {"throttle_rps": s.throttle_rps}
        s.throttle_rps = float(args["rps"]) if args.get("rps") else None
        s.bucket = s.throttle_rps or 0.0
    elif kind == "patch_config":
        workers = [_worker(twin, wid) for wid in args.get("workers") or list(s.workers)]
        reversible = False
        step = twin.profile["inference"]["startup_s"] + 3 if args.get("rolling") else 0
        readmit = bool(args.get("rolling"))
        for i, w in enumerate(workers):
            twin.schedule(i * step, "restart", {"worker": w.id, "tool_ok": True, "readmit": readmit})
    elif kind == "set_power_limit":
        nodes = _scope_nodes(twin, args["scope"])
        watts = float(args["watts"]) if args.get("watts") else twin.profile["gpu"]["tdp_w"]
        before = {"power_limit": {i: s.gpus[i].power_limit for n in nodes for i in s.nodes[n].gpus}}
        for i in before["power_limit"]:
            s.gpus[i].power_limit = watts
    elif kind in ("pause_batch", "resume_batch"):
        nodes = [n for n in _scope_nodes(twin, args["scope"]) if s.nodes[n].role == "batch"]
        before = {"batch_paused": {n: s.nodes[n].batch_paused for n in nodes}}
        for n in nodes:
            s.nodes[n].batch_paused = kind == "pause_batch"
    elif kind == "cordon_node":
        node = s.nodes[args["node"]]
        before = {"cordoned": {node.id: node.cordoned}}
        node.cordoned = True
        if node.worker:
            w = s.workers[node.worker]
            before["worker_state"] = {w.id: w.state}
            twin.fail_inflight(w)
            w.state, w.healthy = "cordoned", False
        twin.log("warn", f"{node.id}: cordoned; hardware ticket opened (REQUIRES_APPROVAL)", node.id, "escalate")
    elif kind == "uncordon_node":
        node = s.nodes[args["node"]]
        before = {"cordoned": {node.id: node.cordoned}}
        node.cordoned = False
        if node.worker and s.workers[node.worker].state == "cordoned":
            s.workers[node.worker].state = "crashed"  # needs an explicit restart
    else:
        raise ValueError(f"unknown action: {kind}")

    token = twin.new_id("chg")
    change = {"token": token, "kind": kind, "args": args, "t": round(twin.now, 1), "reversible": reversible, "before": before}
    s.changes[token] = change
    if not quiet:
        detail = ", ".join(f"{k}={v}" for k, v in args.items())
        twin.log("action", f"ACTION {kind}({detail})" + ("" if reversible else " · irreversible"), args.get("worker") or args.get("node") or args.get("scope"), kind)
    return change


def rollback(twin: Twin, token: str) -> dict:
    s = twin.state
    change = s.changes.get(token)
    if change is None:
        raise ValueError(f"unknown change token: {token}")
    if not change["reversible"]:
        raise ValueError(f"{change['kind']} cannot be rolled back")
    if change.get("rolled_back"):
        raise ValueError(f"{token} already rolled back")
    before = change["before"]
    for wid, v in before.get("weight", {}).items():
        s.workers[wid].weight = v
    for wid, v in before.get("cap", {}).items():
        s.workers[wid].cap = v
    if "throttle_rps" in before:
        s.throttle_rps = before["throttle_rps"]
    for i, v in before.get("power_limit", {}).items():
        s.gpus[int(i)].power_limit = v
    for n, v in before.get("batch_paused", {}).items():
        s.nodes[n].batch_paused = v
    for n, v in before.get("cordoned", {}).items():
        s.nodes[n].cordoned = v
    for wid, v in before.get("worker_state", {}).items():
        s.workers[wid].state = "crashed" if v in ("ready", "hung") else v
    change["rolled_back"] = round(twin.now, 1)
    twin.log("action", f"ROLLBACK {token} ({change['kind']})", None, "rollback")
    return change
