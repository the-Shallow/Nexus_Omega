"""What-if previews: fork the twin, apply each candidate action, compare outcomes.

Each candidate runs under several random seeds so the preview reports a band
(min / median / max across seeds), not a single trajectory.
"""

from __future__ import annotations

import pickle
import random
from concurrent.futures import Executor

from .actions import apply_action
from .model import Twin

METRICS = ("ttft_p95", "tpot_p95", "error_rate", "canary", "capacity", "max_gpu_c", "tps", "queue")


def evaluate(profile: dict, blob: bytes, now: float, actions: list[dict], seed: int, horizon: float) -> list[dict]:
    """Run one candidate from a pickled state. Top-level so it can run in a process pool."""
    twin = Twin(profile, state=pickle.loads(blob), now=now)
    twin.state.rng = random.Random(seed)
    twin.state.series.clear()
    for a in actions:
        apply_action(twin, a["kind"], a.get("args", {}), quiet=True)
    twin.advance(horizon)
    return list(twin.state.series)


def _workers_on(twin: Twin, rack_or_row: str) -> list[str]:
    s = twin.state
    return [
        w.id
        for w in s.workers.values()
        if s.nodes[w.node].rack == rack_or_row or s.racks[s.nodes[w.node].rack].row == rack_or_row
    ]


def candidate_set(twin: Twin, incidents: list[dict] | None = None) -> list[dict]:
    """Runbook candidates for diagnosed incidents, always led by a do-nothing baseline.

    ``incidents`` are ``{"kind", "target", "targets"}`` dicts from a diagnosis. Without
    them the open injected faults are used (manual what-if from the UI).
    """
    s = twin.state
    out = [{"id": "noop", "label": "Do nothing", "actions": []}]
    if incidents is None:
        incidents = [f for f in s.faults.values() if f.get("resolved_at") is None]
    for f in incidents:
        kind, targets = f["kind"], f.get("targets", [])
        if kind in ("worker_hang", "worker_crash"):
            w = targets[0]
            out += [
                {"id": f"restart-{w}", "label": f"Restart {w}", "actions": [{"kind": "restart_worker", "args": {"worker": w}}]},
                {"id": f"drain-{w}", "label": f"Drain {w}", "actions": [{"kind": "drain_worker", "args": {"worker": w}}]},
                {"id": f"cycle-{w}", "label": f"Drain → restart → re-admit {w}", "actions": [{"kind": "restart_worker", "args": {"worker": w, "readmit": True}}]},
            ]
        elif kind == "tool_parser":
            restart_all = [{"kind": "restart_worker", "args": {"worker": w}} for w in targets]
            drain = [{"kind": "drain_worker", "args": {"worker": w}} for w in targets]
            out += [
                {"id": "restart-wave", "label": "Restart wave (no config change)", "actions": restart_all},
                {
                    "id": "parser-only",
                    "label": "Swap parser only (single-sided)",
                    "actions": drain + [{"kind": "patch_config", "args": {"workers": targets, "tool_parser": "qwen25_coder", "rolling": True}}],
                },
                {"id": "patch-all", "label": "Matched pair, restart all at once", "actions": [{"kind": "patch_config", "args": {"workers": targets, "profile": "qwen25-coder-tools-v1"}}]},
                {
                    "id": "drain-patch-rolling",
                    "label": "Matched pair, rolling + re-admit",
                    "actions": drain + [{"kind": "patch_config", "args": {"workers": targets, "profile": "qwen25-coder-tools-v1", "rolling": True}}],
                },
                {
                    "id": "drain-patch-pairs",
                    "label": "Matched pair, 2 at a time + re-admit",
                    "actions": drain + [{"kind": "patch_config", "args": {"workers": targets, "profile": "qwen25-coder-tools-v1", "rolling": True, "parallel": 2}}],
                },
            ]
        elif kind == "traffic_burst":
            healthy = sum(1 for w in s.workers.values() if w.state == "ready" and twin.in_rotation(w))
            out += [
                {"id": "cap-64", "label": "Cap 64 in-flight / worker", "actions": [{"kind": "set_concurrency", "args": {"limit": 64}}]},
                {"id": "throttle", "label": f"Throttle to {healthy * 9} rps", "actions": [{"kind": "throttle", "args": {"rps": healthy * 9}}]},
                {
                    "id": "throttle-cap",
                    "label": "Throttle + cap",
                    "actions": [{"kind": "throttle", "args": {"rps": healthy * 9}}, {"kind": "set_concurrency", "args": {"limit": 64}}],
                },
            ]
        elif kind == "network_degrade":
            ws = _workers_on(twin, f["target"])
            out += [
                {"id": f"drain-{f['target']}", "label": f"Drain workers on {f['target']}", "actions": [{"kind": "drain_worker", "args": {"worker": w}} for w in ws]},
                {"id": f"restart-{f['target']}", "label": f"Restart workers on {f['target']}", "actions": [{"kind": "restart_worker", "args": {"worker": w}} for w in ws]},
            ]
        elif kind in ("crah_failure", "compound"):
            row = next(c.row for c in s.crahs if c.id == (f["target"] or "CRAH-1"))
            out += [
                {"id": f"cap-batch-{row}", "label": f"Cap batch GPUs row {row} to 400 W", "actions": [{"kind": "set_power_limit", "args": {"scope": f"batch:{row}", "watts": 400}}]},
                {"id": f"pause-batch-{row}", "label": f"Pause batch jobs row {row}", "actions": [{"kind": "pause_batch", "args": {"scope": f"batch:{row}"}}]},
                {"id": "pause-batch-all", "label": "Pause batch jobs, all rows", "actions": [{"kind": "pause_batch", "args": {"scope": "batch"}}]},
                {"id": f"drain-inf-{row}", "label": f"Drain inference row {row}", "actions": [{"kind": "drain_worker", "args": {"worker": w}} for w in _workers_on(twin, row)]},
            ]
        elif kind == "power_feed_loss":
            out += [
                {"id": "cap-batch-250", "label": "Cap batch GPUs to 250 W", "actions": [{"kind": "set_power_limit", "args": {"scope": "batch", "watts": 250}}]},
                {"id": "throttle-feed", "label": "Throttle to 28 rps", "actions": [{"kind": "throttle", "args": {"rps": 28}}]},
            ]
        elif kind == "gpu_xid":
            node = s.nodes[f["target"]]
            if node.worker:
                out += [
                    {"id": f"restart-{node.worker}", "label": f"Restart {node.worker}", "actions": [{"kind": "restart_worker", "args": {"worker": node.worker}}]},
                    {"id": f"cordon-{node.id}", "label": f"Cordon {node.id} + escalate", "actions": [{"kind": "cordon_node", "args": {"node": node.id}}]},
                ]
    seen, unique = set(), []
    for c in out:
        if c["id"] not in seen:
            seen.add(c["id"])
            unique.append(c)
    return unique[:7]


def _band(runs: list[list[dict]], metric: str) -> dict:
    lo, mid, hi = [], [], []
    for samples in zip(*runs):
        values = sorted(v for v in (s[metric] for s in samples) if v is not None)
        if not values:
            lo.append(None), mid.append(None), hi.append(None)
            continue
        lo.append(round(values[0], 4))
        mid.append(round(values[len(values) // 2], 4))
        hi.append(round(values[-1], 4))
    return {"lo": lo, "mid": mid, "hi": hi}


def summarize(candidate: dict, runs: list[list[dict]], t0: float) -> dict:
    length = min(len(r) for r in runs)
    runs = [r[:length] for r in runs]
    slo_fraction = sum(sum(s["slo_ok"] for s in r) / max(len(r), 1) for r in runs) / len(runs)
    ttfts = [s["ttft_p95"] for r in runs for s in r if s["ttft_p95"] is not None]
    tail = [r[-10:] for r in runs]
    final_capacity = sum(r[-1]["capacity"] for r in runs) / len(runs)
    recovered = next(
        (runs[0][i]["t"] - t0 for i in range(length) if all(r[j]["slo_ok"] and r[j]["capacity"] >= 0.999 for r in runs for j in range(i, length))),
        None,
    )
    return {
        **candidate,
        "slo_fraction": round(slo_fraction, 3),
        "final_slo_ok": all(all(s["slo_ok"] for s in t) for t in tail),
        "final_capacity": round(final_capacity, 3),
        "recovered_s": None if recovered is None else round(recovered, 1),
        "peak_ttft_p95": round(max(ttfts), 3) if ttfts else None,
        "mean_error": round(sum(s["error_rate"] for r in runs for s in r) / max(length * len(runs), 1), 4),
        "peak_gpu_c": round(max(s["max_gpu_c"] for r in runs for s in r), 1),
        "series": {
            "t": [round(s["t"] - t0, 1) for s in runs[0]],
            "slo": [round(sum(r[i]["slo_ok"] for r in runs) / len(runs), 2) for i in range(length)],
            **{m: _band(runs, m) for m in METRICS},
        },
    }


def preview(
    twin_profile: dict,
    blob: bytes,
    now: float,
    candidates: list[dict],
    horizon: float = 180.0,
    seeds: tuple[int, ...] = (101, 202, 303),
    executor: Executor | None = None,
) -> dict:
    jobs = [(c, seed) for c in candidates for seed in seeds]
    if executor is not None:
        futures = [executor.submit(evaluate, twin_profile, blob, now, c["actions"], seed, horizon) for c, seed in jobs]
        results = [f.result() for f in futures]
    else:
        results = [evaluate(twin_profile, blob, now, c["actions"], seed, horizon) for c, seed in jobs]
    summaries = []
    for i, c in enumerate(candidates):
        runs = results[i * len(seeds) : (i + 1) * len(seeds)]
        summaries.append(summarize(c, runs, now))
    ranked = sorted(
        summaries,
        key=lambda c: (
            -round(c["slo_fraction"], 1),
            not c["final_slo_ok"],
            -c["final_capacity"],
            c["recovered_s"] if c["recovered_s"] is not None else 1e9,
            c["mean_error"],
            c["peak_gpu_c"],
            c["peak_ttft_p95"] or 1e9,
        ),
    )
    return {
        "t0": round(now, 1),
        "horizon": horizon,
        "seeds": list(seeds),
        "calibration": twin_profile.get("calibration", {}),
        "recommended": ranked[0]["id"] if ranked else None,
        "candidates": ranked,
    }


def preview_twin(
    twin: Twin,
    candidates: list[dict] | None = None,
    horizon: float = 180.0,
    seeds: tuple[int, ...] = (101, 202, 303),
    executor: Executor | None = None,
    incidents: list[dict] | None = None,
) -> dict:
    blob = pickle.dumps(twin.state)
    return preview(twin.profile, blob, twin.now, candidates or candidate_set(twin, incidents), horizon, seeds, executor)
