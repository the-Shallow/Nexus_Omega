"""Fault catalog for the twin, linked to the team's failure-category candidates.

Every fault injected here is simulated. ``live_episode`` says whether the same
failure also exists as a real, reproducible episode on the live target, taken
from ``data/infra_candidate_csv.csv`` (the infrastructure taxonomy).
"""

from __future__ import annotations

import csv
from pathlib import Path

from .model import Twin

CANDIDATES_CSV = Path(__file__).resolve().parents[2] / "data" / "infra_candidate_csv.csv"

CATALOG = [
    {
        "kind": "worker_hang",
        "title": "Hung worker",
        "category": "Compute & Worker Failures",
        "candidate_id": None,
        "provenance": "controlled_real_fault (docker pause)",
        "summary": "/health still returns 200 while the engine makes no progress.",
        "target_type": "worker",
        "default_target": "vllm-5",
    },
    {
        "kind": "worker_crash",
        "title": "Worker crash",
        "category": "Compute & Worker Failures",
        "candidate_id": "VLLM-56943",
        "summary": "Engine dies; in-flight requests fail and tracebacks amplify log volume.",
        "target_type": "worker",
        "default_target": "vllm-1",
    },
    {
        "kind": "tool_parser",
        "title": "Silent tool-call failure",
        "category": "Inference & Tool-Calling Failures",
        "candidate_id": "VLLM-32926",
        "summary": "A vLLM upgrade mismatches parser and chat template: 200 OK, tool calls dropped.",
        "target_type": "workers",
        "default_target": "vllm-0,vllm-1,vllm-2,vllm-3",
    },
    {
        "kind": "traffic_burst",
        "title": "Burst overload",
        "category": "Performance & Workload Failures",
        "candidate_id": "VLLM-18826",
        "summary": "3x traffic for 120 s; the vLLM waiting queue grows without bound.",
        "target_type": "hall",
        "default_target": None,
    },
    {
        "kind": "network_degrade",
        "title": "ToR link degradation",
        "category": "Network & Communication Failures",
        "candidate_id": "NETEM-GATEWAY",
        "summary": "+800 ms latency and 6% loss on one rack's top-of-rack switch.",
        "target_type": "rack",
        "default_target": "B3",
    },
    {
        "kind": "crah_failure",
        "title": "CRAH unit trip",
        "category": "Power Cooling & Thermal Failures",
        "candidate_id": "DCGM-720",
        "summary": "A cooling unit trips; supply air warms and GPUs enter thermal slowdown.",
        "target_type": "crah",
        "default_target": "CRAH-1",
    },
    {
        "kind": "power_feed_loss",
        "title": "UPS feed loss",
        "category": "Power Cooling & Thermal Failures",
        "candidate_id": None,
        "provenance": "simulated_telemetry",
        "summary": "Racks fall back to one feed and BMCs cap GPU power.",
        "target_type": "ups",
        "default_target": "UPS-A",
    },
    {
        "kind": "gpu_xid",
        "title": "GPU XID 79",
        "category": "GPU & Hardware Failures",
        "candidate_id": "NVIDIA-XID-48-79-94",
        "summary": "A GPU falls off the bus; its replica crash-loops until the node is cordoned.",
        "target_type": "node",
        "default_target": "A4-n2",
    },
    {
        "kind": "compound",
        "title": "Thermal → XID cascade",
        "category": "Cascading & Compound Failures",
        "candidate_id": "COMPOUND-THERMAL-XID-QUEUE-TOOL",
        "summary": "CRAH-1 trips under elevated load; hot GPUs throw XIDs and traffic shifts.",
        "target_type": "hall",
        "default_target": None,
    },
]

FIELD_REPAIRABLE = {"network_degrade", "crah_failure", "power_feed_loss", "gpu_xid", "compound", "worker_hang"}


def _load_candidates() -> dict[str, dict]:
    if not CANDIDATES_CSV.exists():
        return {}
    with CANDIDATES_CSV.open(newline="") as fh:
        return {row["candidate_id"]: row for row in csv.DictReader(fh)}


def catalog() -> list[dict]:
    rows = _load_candidates()
    out = []
    for entry in CATALOG:
        item = dict(entry)
        row = rows.get(entry["candidate_id"] or "")
        if row:
            if row["upstream_url"].startswith("http"):
                item["upstream_url"] = row["upstream_url"]
            item["reproduction_class"] = row["reproduction_class"]
            item["live_episode"] = row["execution_mode"]  # real | simulated | hybrid
            item["decision"] = row["decision"]
        else:
            item["live_episode"] = "real" if "controlled_real_fault" in item.get("provenance", "") else "simulated"
        out.append(item)
    return out


def _entry(kind: str) -> dict:
    for entry in CATALOG:
        if entry["kind"] == kind:
            return entry
    raise ValueError(f"unknown fault kind: {kind}")


def inject(twin: Twin, kind: str, target: str | None = None) -> dict:
    entry = _entry(kind)
    s = twin.state
    target = target or entry["default_target"]
    targets = [t.strip() for t in target.split(",")] if target else []
    if kind in ("worker_hang", "worker_crash", "tool_parser"):
        for t in targets:
            if t not in s.workers:
                raise ValueError(f"unknown worker: {t}")
    fid = twin.new_id("F")
    fault = {
        "id": fid,
        "kind": kind,
        "title": entry["title"],
        "category": entry["category"],
        "candidate_id": entry["candidate_id"],
        "target": target,
        "targets": targets,
        "t": round(twin.now, 1),
        "resolved_at": None,
    }
    if kind == "worker_hang":
        for t in targets:
            s.workers[t].state = "hung"
    elif kind == "worker_crash":
        for t in targets:
            twin.crash(s.workers[t], "EngineCore died unexpectedly")
    elif kind == "tool_parser":
        # A vLLM upgrade rolls out with the tokenizer's default chat template, which no
        # longer asks the model for the Hermes envelope the configured parser expects.
        for t in targets:
            twin.set_config(s.workers[t], {"image": "vllm 0.28.0", "tool_parser": "hermes", "chat_template": "tokenizer-default"}, "rollout: vLLM 0.27.1 → 0.28.0 (wave 1)")
    elif kind == "traffic_burst":
        s.burst = 3.0
        twin.schedule(120, "burst_end", {})
    elif kind == "network_degrade":
        rack = s.racks[target]
        rack.tor_latency_s, rack.tor_loss = 0.8, 0.06
    elif kind == "crah_failure":
        _crah(twin, target).running = False
    elif kind == "power_feed_loss":
        s.ups[target] = False
    elif kind == "gpu_xid":
        node = s.nodes[target]
        twin.xid(s.gpus[node.gpus[3]], 79, "injected")
    elif kind == "compound":
        _crah(twin, "CRAH-1").running = False
        s.burst = 1.4
        twin.schedule(300, "burst_end", {})
    s.faults[fid] = fault
    twin.log("fault", f"FAULT INJECTED · {entry['title']}" + (f" → {target}" if target else ""), target, kind)
    return fault


def _crah(twin: Twin, crah_id: str):
    for c in twin.state.crahs:
        if c.id == crah_id:
            return c
    raise ValueError(f"unknown CRAH: {crah_id}")


def repair(twin: Twin, fid: str) -> dict:
    """Field repair by a human: restores infrastructure. Software faults need an action instead."""
    s = twin.state
    fault = s.faults[fid]
    kind = fault["kind"]
    if kind not in FIELD_REPAIRABLE:
        raise ValueError(f"{kind} is a software fault; fix it with an action (restart, patch_config)")
    if kind == "worker_hang":
        for t in fault["targets"]:
            if s.workers[t].state == "hung":
                s.workers[t].state = "ready"
    elif kind == "network_degrade":
        rack = s.racks[fault["target"]]
        rack.tor_latency_s, rack.tor_loss = 0.0, 0.0
    elif kind in ("crah_failure", "compound"):
        _crah(twin, fault["target"] or "CRAH-1").running = True
    elif kind == "power_feed_loss":
        s.ups[fault["target"]] = True
    elif kind == "gpu_xid":
        for i in s.nodes[fault["target"]].gpus:
            s.gpus[i].fallen, s.gpus[i].xid = False, 0
    fault["resolved_at"] = round(twin.now, 1)
    twin.log("ok", f"field repair complete: {fault['title']}", fault["target"], "repair")
    return fault
