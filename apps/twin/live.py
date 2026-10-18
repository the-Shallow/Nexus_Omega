"""Live mode: the real Brev fleet in the twin's frame shape, plus the box operator passthrough.

Everything here reaches the box through SSH-forwarded ports (web/README.md):

    NEXUS_GATEWAY_URL     gateway admin API      default http://127.0.0.1:8110  (NEXUS_ADMIN_TOKEN)
    NEXUS_PROMETHEUS_URL  Prometheus + DCGM      default http://127.0.0.1:9090
    NEXUS_OPERATOR_URL    box operator app       unset = results come from local files, no Break it
                                                 (NEXUS_OPERATOR_TOKEN, added here, never sent to the browser)

A live frame keeps the twin's field names so the same panels can draw it, but a
field with no real source is null. Nothing is filled in from the simulator.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import time

import httpx
from fastapi import WebSocket

GATEWAY_URL = os.environ.get("NEXUS_GATEWAY_URL", "http://127.0.0.1:8110").rstrip("/")
PROMETHEUS_URL = os.environ.get("NEXUS_PROMETHEUS_URL", "http://127.0.0.1:9090").rstrip("/")
OPERATOR_URL = os.environ.get("NEXUS_OPERATOR_URL", "").rstrip("/")
OPERATOR_TOKEN = os.environ.get("NEXUS_OPERATOR_TOKEN", "")
ADMIN_TOKEN = os.environ.get("NEXUS_ADMIN_TOKEN", "")
FRAME_S = 1.0
WORKERS = ("a", "b")
SLO = {"ttft_p95_s": 0.5, "tpot_p95_s": None, "error_rate": 0.0}  # nexus.baseline.rules.ROUTE_LIMITS

PROMQL = {
    "ttft_p95": 'histogram_quantile(0.95, sum by (instance, le) (rate(vllm:time_to_first_token_seconds_bucket[1m])))',
    "waiting": "vllm:num_requests_waiting",
    "kv": "vllm:kv_cache_usage_perc",
    "up": 'up{job="vllm"}',
    "gpu_util": "DCGM_FI_DEV_GPU_UTIL",
    "gpu_power": "DCGM_FI_DEV_POWER_USAGE",
    "gpu_temp": "DCGM_FI_DEV_GPU_TEMP",
}


def operator_headers() -> dict:
    return {"authorization": f"Bearer {OPERATOR_TOKEN}"} if OPERATOR_TOKEN else {}


def admin_headers() -> dict:
    return {"authorization": f"Bearer {ADMIN_TOKEN}"} if ADMIN_TOKEN else {}


def topology() -> dict:
    """One H100 node shared by workers a and b. Same shape as nexus.simulator.telemetry.topology."""
    return {
        "profile": "brev-live", "title": "Brev fleet (live)",
        "calibration": {"source": "live", "confidence": "measured",
                        "notes": "Real gateway and Prometheus data; one H100 shared by both workers."},
        "hall": {"rows": ["A"], "racks_per_row": 1, "nodes_per_rack": 2, "gpus_per_node": 1},
        "gpu": {"model": "NVIDIA H100 PCIe", "tdp_w": 350, "slowdown_c": None, "shutdown_c": None},
        "slo": SLO, "model_label": "Qwen2.5-Coder-7B",
        "racks": [{"id": "A1", "row": "A", "index": 0, "nodes": ["node-a", "node-b"]}],
        "nodes": [{"id": f"node-{w}", "rack": "A1", "slot": i, "role": "inference", "worker": w, "gpus": [0]}
                  for i, w in enumerate(WORKERS)],
        "workers": [{"id": w, "node": f"node-{w}"} for w in WORKERS],
        "crahs": [], "ups": [], "clock_base_s": 0, "base_rps": None,
    }


def _vector(body: dict, label: str) -> dict[str, float | None]:
    out = {}
    for row in body.get("data", {}).get("result", []):
        value = float(row["value"][1])
        out[row["metric"].get(label, "")] = None if math.isnan(value) else value
    return out


def _worker(instance: str) -> str:
    return instance.removeprefix("nexus-").split(":")[0]


class LivePoller:
    """Polls the box once per frame and keeps the counters needed for rates."""

    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.seq = 0
        self.prev: tuple[float, dict] | None = None
        self.doctor_rev = ""

    async def _get(self, client: httpx.AsyncClient, url: str, **kw) -> dict | list | None:
        try:
            resp = await client.get(url, timeout=2.0, **kw)
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPError, ValueError):
            return None

    async def _prom(self, client: httpx.AsyncClient) -> dict[str, dict]:
        bodies = await asyncio.gather(*(self._get(client, f"{PROMETHEUS_URL}/api/v1/query", params={"query": q})
                                        for q in PROMQL.values()))
        out = {}
        for key, body in zip(PROMQL, bodies):
            label = "gpu" if key.startswith("gpu_") else "instance"
            vec = _vector(body or {}, label)
            out[key] = vec if label == "gpu" else {_worker(k): v for k, v in vec.items()}
        return out

    async def frame(self, client: httpx.AsyncClient, doctor_fetch=None) -> dict:
        admin, prom, job = await asyncio.gather(
            self._get(client, f"{GATEWAY_URL}/admin/workers", headers=admin_headers()),
            self._prom(client),
            self._get(client, f"{OPERATOR_URL}/jobs", headers=operator_headers()) if OPERATOR_URL else _none(),
        )
        admin = admin or {}
        now = time.monotonic()
        dt = (now - self.prev[0]) if self.prev else None
        prev = self.prev[1] if self.prev else {}
        self.prev = (now, {w: dict(s) for w, s in admin.items()})
        self.seq += 1

        workers, flows = [], {}
        for w in WORKERS:
            s, p = admin.get(w), prev.get(w, {})
            up = prom["up"].get(w)
            d_req = (s["requests"] - p["requests"]) if s and "requests" in p else None
            d_err = (s["errors"] - p["errors"]) if s and "errors" in p else None
            workers.append({
                "id": w, "state": "crashed" if up == 0 else "ready" if up == 1 else None,
                "healthy": None if up is None else up == 1, "weight": s and s["weight"],
                "running": s and s["active"], "waiting": prom["waiting"].get(w), "kv": prom["kv"].get(w),
                "ttft_p95": prom["ttft_p95"].get(w),
                "rps": round(d_req / dt, 2) if d_req is not None and dt else None,
                "error_rate": round(d_err / d_req, 4) if d_req else (0.0 if d_req == 0 else None),
                "silent": None, "tps": None, "canary": None, "tool_ok": None, "restarts": None, "ready_in": None,
                "draining": s and s["drained"], "config": None,
            })
            flows[w] = {"disp": d_req, "ok": None if d_req is None else d_req - (d_err or 0), "err": d_err,
                        "silent": None}

        ttfts = [w["ttft_p95"] for w in workers if w["ttft_p95"] is not None]
        rps = [w["rps"] for w in workers if w["rps"] is not None]
        reqs = sum(f["disp"] or 0 for f in flows.values())
        errs = sum(f["err"] or 0 for f in flows.values())
        counted = any(f["disp"] is not None for f in flows.values())
        error_rate = round(errs / reqs, 4) if reqs else (0.0 if counted else None)
        ttft = max(ttfts) if ttfts else None
        temp, util, power = (prom[k].get("0") for k in ("gpu_temp", "gpu_util", "gpu_power"))
        kpi = {
            "rps_in": round(sum(rps), 2) if rps else None, "ttft_p50": None, "ttft_p95": ttft, "tpot_p95": None,
            "error_rate": error_rate, "silent_rate": None, "tps": None,
            "queue": sum(w["waiting"] or 0 for w in workers), "running": sum(w["running"] or 0 for w in workers),
            "canary": None, "capacity": None, "it_kw": None if power is None else round(power / 1000, 3),
            "cooling_kw": None, "pue": None, "supply_c": None, "max_gpu_c": temp, "throttled": None,
            "slo_ok": None if ttft is None and error_rate is None else
            (ttft is None or ttft <= SLO["ttft_p95_s"]) and (error_rate or 0) <= SLO["error_rate"],
        }
        active = next((j for j in job or [] if j.get("state") in ("queued", "running")), None)
        frame = {
            "t": round(now - self.t0, 2), "seq": self.seq, "kpi": kpi,
            "hall": {"supply_c": None, "it_kw": kpi["it_kw"], "cooling_kw": None, "pue": None, "airflow": {},
                     "return_c": None, "crahs": [], "ups": {}},
            "racks": [{"id": "A1", "inlet": None, "exhaust": None, "power_kw": kpi["it_kw"], "capped": None,
                       "net": None}],
            "gpu": {"temp": [temp], "util": [None if util is None else util / 100], "power": [power],
                    "clock": [None], "flag": [0]},
            "nodes": {f"node-{w}": [0, 0] for w in WORKERS},
            "workers": workers, "flows": flows,
            "gateway": {"queue": sum((admin.get(w) or {}).get("queued", 0) for w in WORKERS), "throttle_rps": None,
                        "in": reqs if counted else None, "shed": None, "burst": False},
            "faults": [{"id": active["id"], "kind": active["fault"], "title": active["fault"], "target": None,
                        "targets": [], "candidate_id": active["fault"], "t": None, "resolved_at": None}]
            if active else [],
            "sources": {"gateway": bool(admin), "prometheus": any(prom[k] for k in prom), "operator": job is not None},
            "job": active,
        }
        run_ids = (active or {}).get("run_ids") or []
        if doctor_fetch and run_ids:
            snap = await doctor_fetch(run_ids[-1])
            rev = f"{snap['id']}:{len(snap['events'])}" if snap else ""
            if rev != self.doctor_rev:
                self.doctor_rev = rev
                frame["doctor"] = snap
        frame["doctors"] = {"enabled": True, "autopilot": True, "active": run_ids[-1] if run_ids else None}
        return frame


async def _none() -> None:
    return None



async def status() -> dict:
    """Which live sources this server can reach right now."""
    async with httpx.AsyncClient() as client:
        async def ok(url: str, **kw) -> httpx.Response | None:
            try:
                resp = await client.get(url, timeout=1.5, **kw)
                return resp if resp.status_code == 200 else None
            except httpx.HTTPError:
                return None

        gateway, prometheus, operator = await asyncio.gather(
            ok(f"{GATEWAY_URL}/health"), ok(f"{PROMETHEUS_URL}/-/ready"),
            ok(f"{OPERATOR_URL}/health", headers=operator_headers()) if OPERATOR_URL else _none())
    return {"gateway": gateway is not None, "prometheus": prometheus is not None, "operator": operator is not None,
            "operator_configured": bool(OPERATOR_URL), "box": any(r is not None for r in (gateway, prometheus, operator)),
            "active_job": operator.json().get("active_job") if operator is not None else None}


async def stream(ws: WebSocket, doctor_fetch=None) -> None:
    """Send hello + one live frame per second until the client goes away."""
    await ws.send_text(json.dumps({"type": "hello", "source": "live", "topology": topology(), "events": []}))
    poller = LivePoller()
    async with httpx.AsyncClient() as client:
        while True:
            started = time.monotonic()
            frame = await poller.frame(client, doctor_fetch)
            await ws.send_text(json.dumps(frame, separators=(",", ":")))
            await asyncio.sleep(max(0.0, FRAME_S - (time.monotonic() - started)))
