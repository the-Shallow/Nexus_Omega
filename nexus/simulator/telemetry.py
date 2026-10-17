"""Serialize twin state for the 3D view and as Prometheus text.

Metric names follow DCGM exporter and vLLM conventions so the agent's
``query_metrics`` tool can read the twin like the live target. Every series is
labelled ``source="twin"``.
"""

from __future__ import annotations

from .model import Twin


def topology(twin: Twin) -> dict:
    p, s = twin.profile, twin.state
    return {
        "profile": p["name"],
        "title": p["title"],
        "calibration": p["calibration"],
        "hall": {k: p["hall"][k] for k in ("rows", "racks_per_row", "nodes_per_rack", "gpus_per_node")},
        "gpu": p["gpu"],
        "slo": p["slo"],
        "model_label": p["inference"]["model_label"],
        "racks": [{"id": r.id, "row": r.row, "index": r.index, "nodes": r.nodes} for r in s.racks.values()],
        "nodes": [
            {"id": n.id, "rack": n.rack, "slot": n.slot, "role": n.role, "worker": n.worker, "gpus": n.gpus}
            for n in s.nodes.values()
        ],
        "workers": [{"id": w.id, "node": w.node} for w in s.workers.values()],
        "crahs": [{"id": c.id, "row": c.row, "capacity_kw": c.capacity_kw} for c in s.crahs],
        "ups": list(s.ups),
        "clock_base_s": 1 * 3600 + 47 * 60,  # matches nexus.doctors.CLOCK_BASE_S
        "base_rps": p["traffic"]["base_rps"],
    }


def _r(x: float | None, nd: int = 3) -> float | None:
    return None if x is None else round(x, nd)


def frame(twin: Twin, since_seq: int) -> dict:
    """One streaming frame. Consumes the per-worker flow counters."""
    s = twin.state
    kpi = s.series[-1] if s.series else twin.kpis()
    workers = []
    flows = {}
    for w in s.workers.values():
        k = twin.worker_kpis(w)
        workers.append(
            {
                "id": w.id,
                "state": w.state,
                "healthy": w.healthy,
                "weight": w.weight,
                "cap": w.cap,
                "running": len(w.running),
                "waiting": len(w.waiting),
                "kv": _r(w.kv_used / w.kv_capacity),
                "ttft_p95": _r(k["ttft_p95"]),
                "rps": _r(k["rps"], 2),
                "error_rate": _r(k["error_rate"]),
                "silent": k["silent"],
                "tps": round(k["tps"]),
                "canary": w.canary_ok,
                "tool_ok": w.tool_ok,
                "log_rate": round(w.log_rate),
                "preemptions": w.preemptions,
                "restarts": w.restarts,
                "ready_in": _r(max(0.0, w.ready_at - twin.now), 1) if w.state == "restarting" else None,
                "draining": w.drain_deadline is not None,
                "clock": _r(twin.clock_of(w)),
                "config": w.config,
            }
        )
        flows[w.id] = dict(w.flow)
        w.flow = {"disp": 0, "ok": 0, "err": 0, "silent": 0}
    gateway_flow = dict(s.gateway_flow)
    s.gateway_flow = {"in": 0, "shed": 0}
    flags = [3 if g.fallen else 1 if g.throttle == "thermal" else 2 if g.throttle == "power" else 0 for g in s.gpus]
    events = [e for e in s.events if e["seq"] > since_seq]
    return {
        "t": round(twin.now, 2),
        "seq": s.event_seq,
        "kpi": kpi,
        "hall": {
            "supply_c": round(s.supply_c, 2),
            "it_kw": round(s.it_kw, 1),
            "cooling_kw": round(s.cooling_kw, 1),
            "pue": round(s.pue, 3),
            "airflow": s.airflow,
            "return_c": round(sum(r.exhaust for r in s.racks.values()) / len(s.racks), 2),
            "crahs": [{"id": c.id, "running": c.running} for c in s.crahs],
            "ups": s.ups,
        },
        "racks": [
            {
                "id": r.id,
                "inlet": round(r.inlet, 1),
                "exhaust": round(r.exhaust, 1),
                "power_kw": round(r.power_kw, 1),
                "capped": r.cap_kw is not None and r.power_kw >= r.cap_kw - 0.5,
                "net": r.tor_loss > 0 or r.tor_latency_s > 0,
            }
            for r in s.racks.values()
        ],
        "gpu": {
            "temp": [round(g.temp, 1) for g in s.gpus],
            "util": [round(g.util, 2) for g in s.gpus],
            "power": [round(g.power) for g in s.gpus],
            "clock": [round(g.clock, 2) for g in s.gpus],
            "flag": flags,
        },
        "nodes": {n.id: [int(n.cordoned), int(n.batch_paused)] for n in s.nodes.values()},
        "workers": workers,
        "flows": flows,
        "gateway": {
            "queue": len(s.queue),
            "throttle_rps": s.throttle_rps,
            "in": gateway_flow["in"],
            "shed": gateway_flow["shed"],
            "burst": s.burst,
        },
        "faults": list(s.faults.values()),
        "changes": list(s.changes.values())[-12:],
        "config_log": s.config_log[-12:],
        "events": events,
    }


def prometheus(twin: Twin) -> str:
    s, p = twin.state, twin.profile
    gp = p["gpu"]
    lines = ["# Nexus Ω digital twin: all series are simulated (source=\"twin\")."]

    def gauge(name: str, help_: str, rows: list[tuple[dict, float]]) -> None:
        lines.append(f"# HELP {name} {help_}")
        lines.append(f"# TYPE {name} gauge")
        for labels, value in rows:
            lab = ",".join(f'{k}="{v}"' for k, v in {**labels, "source": "twin"}.items())
            lines.append(f"{name}{{{lab}}} {value}")

    gl = [({"gpu": g.local, "Hostname": g.node, "modelName": gp["model"]}, g) for g in s.gpus]
    gauge("DCGM_FI_DEV_GPU_TEMP", "GPU temperature (C).", [(lab, round(g.temp, 1)) for lab, g in gl])
    gauge("DCGM_FI_DEV_POWER_USAGE", "Power draw (W).", [(lab, round(g.power, 1)) for lab, g in gl])
    gauge("DCGM_FI_DEV_GPU_UTIL", "GPU utilization (%).", [(lab, round(g.util * 100)) for lab, g in gl])
    gauge("DCGM_FI_DEV_SM_CLOCK", "SM clock (MHz).", [(lab, round(g.clock * gp["max_sm_clock_mhz"]) if g.util > 0.05 else gp["idle_sm_clock_mhz"]) for lab, g in gl])
    gauge("DCGM_FI_DEV_FB_USED", "Framebuffer used (MiB).", [(lab, round(g.fb_used_mb)) for lab, g in gl])
    gauge("DCGM_FI_DEV_THERMAL_VIOLATION", "Throttling duration due to thermal violation (us).", [(lab, int(g.thermal_violation_s * 1e6)) for lab, g in gl])
    gauge("DCGM_FI_DEV_POWER_VIOLATION", "Throttling duration due to power violation (us).", [(lab, int(g.power_violation_s * 1e6)) for lab, g in gl])
    gauge("DCGM_FI_DEV_XID_ERRORS", "Value of the last XID error.", [(lab, g.xid) for lab, g in gl])

    wl = [({"model_name": p["inference"]["model_label"], "instance": w.id}, w) for w in s.workers.values()]
    gauge("vllm:num_requests_running", "Requests in model execution batches.", [(lab, len(w.running)) for lab, w in wl])
    gauge("vllm:num_requests_waiting", "Requests waiting to be processed.", [(lab, len(w.waiting)) for lab, w in wl])
    gauge("vllm:kv_cache_usage_perc", "KV-cache usage (1 = 100%).", [(lab, round(w.kv_used / w.kv_capacity, 4)) for lab, w in wl])
    gauge("vllm:num_preemptions_total", "Cumulative preemptions.", [(lab, w.preemptions) for lab, w in wl])

    k = s.series[-1] if s.series else twin.kpis()
    gauge("nexus_twin_ttft_p95_seconds", "Gateway p95 time to first token over 10 s.", [({}, k["ttft_p95"] if k["ttft_p95"] is not None else "NaN")])
    gauge("nexus_twin_error_rate", "Failed, timed-out or shed fraction over 10 s.", [({}, round(k["error_rate"], 4))])
    gauge("nexus_twin_canary_pass_ratio", "Tool-call canary pass ratio across in-rotation workers.", [({}, round(k["canary"], 3))])
    gauge("nexus_twin_supply_air_celsius", "CRAH supply air temperature.", [({}, round(s.supply_c, 2))])
    gauge("nexus_twin_it_power_kw", "IT load (kW).", [({}, round(s.it_kw, 1))])
    gauge("nexus_twin_pue", "Power usage effectiveness.", [({}, round(s.pue, 3))])
    return "\n".join(lines) + "\n"
