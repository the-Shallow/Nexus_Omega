"""Read-only diagnostic tools backed by the digital twin.

Each tool mirrors a tool from docs/agentic-requirements.md §7 so the same calls
can later be pointed at the live target. Results are small, typed dicts.
"""

from __future__ import annotations

from nexus.simulator.model import Twin, tools_compatible


class ToolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


TOOL_CLASSES = {
    "get_topology": "read",
    "list_workers": "read",
    "query_metrics": "read",
    "read_logs": "read",
    "read_serving_config": "read",
    "get_change_history": "read",
    "read_raw_generation": "read",
    "run_canary": "test",
    "inspect_gpu": "read",
    "inspect_facility": "read",
    "inspect_network": "read",
    "retrieve_incident_context": "read",
    "simulate_action": "test",
}


def _worker(twin: Twin, service: str):
    if service not in twin.state.workers:
        raise ToolError("unknown_target", f"unknown service: {service}")
    return twin.state.workers[service]


def get_topology(twin: Twin) -> dict:
    s = twin.state
    return {
        "gateway": "edge-gateway",
        "workers": len(s.workers),
        "racks": len(s.racks),
        "gpus": len(s.gpus),
        "cooling_units": [c.id for c in s.crahs],
        "power_feeds": list(s.ups),
    }


def list_workers(twin: Twin) -> list[dict]:
    out = []
    for w in twin.state.workers.values():
        k = twin.worker_kpis(w)
        out.append(
            {
                "service": w.id,
                "node": w.node,
                "state": w.state,
                "health": "200" if w.healthy else "unreachable",
                "in_rotation": twin.in_rotation(w),
                "tokens_per_s": round(k["tps_now"]),
                "waiting": len(w.waiting),
                "error_rate": round(k["error_rate"], 3),
                "canary": "pass" if w.canary_ok else "fail",
            }
        )
    return out


def query_metrics(twin: Twin, metric: str, window_s: float = 60.0) -> dict:
    series = [x for x in twin.state.series if x["t"] >= twin.now - window_s]
    if not series or metric not in series[-1]:
        raise ToolError("unknown_metric", f"no series for {metric}")
    values = [x[metric] for x in series if x[metric] is not None]
    return {
        "metric": metric,
        "window_s": window_s,
        "latest": series[-1][metric],
        "min": min(values) if values else None,
        "max": max(values) if values else None,
        "samples": len(series),
    }


def read_logs(twin: Twin, service: str, limit: int = 8) -> dict:
    w = _worker(twin, service)
    lines = [
        f"T+{e['t']:.0f}s {e['level'].upper()} {e['msg']}"
        for e in twin.state.events
        if e.get("target") == service
    ][-limit:]
    if not tools_compatible(w.config):
        # What the Hermes parser does with output that lacks its envelope (vLLM #32926).
        lines.append(f"WARNING {w.config['tool_parser']}_tool_parser: no <tool_call> tag in model output; returning text as content")
    if w.state == "hung":
        lines.append("engine: last scheduler step 40+ s ago; /health still 200")
    return {"service": service, "lines": lines, "truncated": False}


def read_serving_config(twin: Twin, service: str) -> dict:
    w = _worker(twin, service)
    return {
        "service": service,
        **w.config,
        "enable_auto_tool_choice": True,
        "contract": "matched" if tools_compatible(w.config) else "mismatched",
    }


def get_change_history(twin: Twin, window_s: float = 1800.0) -> list[dict]:
    return [c for c in twin.state.config_log if c["t"] >= twin.now - window_s]


def read_raw_generation(twin: Twin, service: str, request_id: str = "latest") -> dict:
    w = _worker(twin, service)
    if request_id != "latest":
        raise ToolError("not_found", f"{request_id} rotated out of the trace buffer")
    call = '{"name": "create_ticket", "arguments": {"priority": "high", "summary": "Refund not received"}}'
    if tools_compatible(w.config):
        raw = f"<tool_call>\n{call}\n</tool_call>"
        structured = {"content": None, "tool_calls": [{"function": {"name": "create_ticket"}}], "http_status": 200}
    else:
        raw = call
        structured = {"content": call, "tool_calls": [], "http_status": 200}
    return {"service": service, "request_id": f"req-{twin.state.next_rid}", "raw_output": raw, "structured_response": structured, "sample": "twin"}


def run_canary(twin: Twin, service: str | None = None) -> dict:
    ws = [w for w in twin.state.workers.values() if service in (None, w.id)]
    results = {w.id: "pass" if w.canary_ok else "fail" for w in ws}
    return {"cases_per_worker": 4, "results": results, "failing": [k for k, v in results.items() if v == "fail"]}


def inspect_gpu(twin: Twin, node: str) -> dict:
    if node not in twin.state.nodes:
        raise ToolError("unknown_target", f"unknown node: {node}")
    gpus = [twin.state.gpus[i] for i in twin.state.nodes[node].gpus]
    return {
        "node": node,
        "DCGM_FI_DEV_GPU_TEMP": [round(g.temp) for g in gpus],
        "DCGM_FI_DEV_POWER_USAGE": [round(g.power) for g in gpus],
        "DCGM_FI_DEV_XID_ERRORS": [g.xid for g in gpus],
        "throttle": [g.throttle or "none" for g in gpus],
    }


def inspect_facility(twin: Twin) -> dict:
    s = twin.state
    return {
        "supply_air_c": round(s.supply_c, 1),
        "crah": {c.id: "running" if c.running else "tripped" for c in s.crahs},
        "ups": {u: "online" if on else "feed lost" for u, on in s.ups.items()},
        "it_load_kw": round(s.it_kw),
        "throttled_gpus": sum(1 for g in s.gpus if g.throttle),
    }


def inspect_network(twin: Twin, rack: str) -> dict:
    if rack not in twin.state.racks:
        raise ToolError("unknown_target", f"unknown rack: {rack}")
    r = twin.state.racks[rack]
    return {"rack": rack, "tor_latency_ms": round(r.tor_latency_s * 1000), "tor_loss_pct": round(r.tor_loss * 100, 1)}
