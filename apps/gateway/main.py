"""Team-owned gateway in front of the vLLM target workers.

Forwards OpenAI-compatible requests to one worker chosen by route weight, and
exposes admin endpoints the agent's action tools use to drain or reweight a
worker. Workers are configured with NEXUS_WORKERS, e.g.
    NEXUS_WORKERS="a=http://nexus-a:8000,b=http://nexus-b:8000"
"""
from __future__ import annotations

import json
import os
import random
import time

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field


# Upper bounds (seconds) of the per-worker latency histogram. Latency is
# measured at the gateway, so it includes the network path that the workers'
# own vLLM metrics cannot see.
LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30]


def parse_workers(spec: str) -> dict[str, dict]:
    workers = {}
    for item in filter(None, (s.strip() for s in spec.split(","))):
        worker_id, url = item.split("=", 1)
        workers[worker_id] = {"url": url.rstrip("/"), "weight": 1.0, "drained": False,
                              "requests": 0, "errors": 0, "last_error": None,
                              "latency": {"buckets": [0] * len(LATENCY_BUCKETS), "sum": 0.0, "count": 0}}
    return workers


WORKERS = parse_workers(os.environ.get("NEXUS_WORKERS", "a=http://nexus-a:8000"))
client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5))
app = FastAPI(title="Nexus Ω gateway")


def pick_worker() -> str:
    eligible = {w: s["weight"] for w, s in WORKERS.items() if not s["drained"] and s["weight"] > 0}
    if not eligible:
        raise HTTPException(503, "no eligible workers (all drained or zero weight)")
    return random.choices(list(eligible), weights=list(eligible.values()))[0]


def record_latency(worker_id: str, seconds: float) -> None:
    hist = WORKERS[worker_id]["latency"]
    for i, bound in enumerate(LATENCY_BUCKETS):
        if seconds <= bound:
            hist["buckets"][i] += 1
    hist["sum"] += seconds
    hist["count"] += 1


def record_error(worker_id: str, message: str) -> None:
    WORKERS[worker_id]["errors"] += 1
    WORKERS[worker_id]["last_error"] = {"at": time.time(), "message": message[:300]}


@app.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def proxy(path: str, request: Request):
    worker_id = pick_worker()
    worker = WORKERS[worker_id]
    worker["requests"] += 1
    url = f"{worker['url']}/v1/{path}"
    started = time.monotonic()
    body = await request.body()
    headers = {"content-type": request.headers.get("content-type", "application/json")}
    wants_stream = False
    if body:
        try:
            wants_stream = bool(json.loads(body).get("stream"))
        except (ValueError, AttributeError):
            pass

    if wants_stream:
        upstream = client.build_request(request.method, url, content=body, headers=headers)
        try:
            resp = await client.send(upstream, stream=True)
        except httpx.HTTPError as exc:
            record_error(worker_id, repr(exc))
            record_latency(worker_id, time.monotonic() - started)
            raise HTTPException(502, f"worker {worker_id} unreachable",
                                headers={"x-nexus-worker": worker_id}) from exc
        record_latency(worker_id, time.monotonic() - started)  # time to response headers
        if resp.status_code >= 500:
            record_error(worker_id, f"HTTP {resp.status_code}")

        async def relay():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()

        return StreamingResponse(relay(), status_code=resp.status_code,
                                 media_type=resp.headers.get("content-type"),
                                 headers={"x-nexus-worker": worker_id})

    try:
        resp = await client.request(request.method, url, content=body, headers=headers)
    except httpx.HTTPError as exc:
        record_error(worker_id, repr(exc))
        record_latency(worker_id, time.monotonic() - started)
        raise HTTPException(502, f"worker {worker_id} unreachable",
                            headers={"x-nexus-worker": worker_id}) from exc
    record_latency(worker_id, time.monotonic() - started)
    if resp.status_code >= 500:
        record_error(worker_id, f"HTTP {resp.status_code}: {resp.text}")
    return Response(resp.content, status_code=resp.status_code,
                    media_type=resp.headers.get("content-type"),
                    headers={"x-nexus-worker": worker_id})


class WeightBody(BaseModel):
    weight: float = Field(ge=0, le=10)


def get_worker(worker_id: str) -> dict:
    if worker_id not in WORKERS:
        raise HTTPException(404, f"unknown worker '{worker_id}'")
    return WORKERS[worker_id]


@app.get("/admin/workers")
async def list_workers():
    return {w: {k: v for k, v in s.items()} for w, s in WORKERS.items()}


@app.post("/admin/workers/{worker_id}/weight")
async def set_weight(worker_id: str, body: WeightBody):
    worker = get_worker(worker_id)
    before = worker["weight"]
    worker["weight"] = body.weight
    return {"worker": worker_id, "before": before, "after": body.weight}


@app.post("/admin/workers/{worker_id}/drain")
async def drain(worker_id: str):
    worker = get_worker(worker_id)
    before = worker["drained"]
    worker["drained"] = True
    return {"worker": worker_id, "drained_before": before, "drained": True}


@app.post("/admin/workers/{worker_id}/undrain")
async def undrain(worker_id: str):
    worker = get_worker(worker_id)
    before = worker["drained"]
    worker["drained"] = False
    return {"worker": worker_id, "drained_before": before, "drained": False}


@app.get("/health")
async def health():
    eligible = [w for w, s in WORKERS.items() if not s["drained"] and s["weight"] > 0]
    return JSONResponse({"ok": bool(eligible), "eligible_workers": eligible},
                        status_code=200 if eligible else 503)


@app.get("/metrics")
async def metrics():
    lines = [
        "# TYPE nexus_gateway_requests_total counter",
        "# TYPE nexus_gateway_errors_total counter",
        "# TYPE nexus_gateway_route_weight gauge",
        "# TYPE nexus_gateway_drained gauge",
        "# TYPE nexus_gateway_request_seconds histogram",
    ]
    for w, s in WORKERS.items():
        lines += [
            f'nexus_gateway_requests_total{{worker="{w}"}} {s["requests"]}',
            f'nexus_gateway_errors_total{{worker="{w}"}} {s["errors"]}',
            f'nexus_gateway_route_weight{{worker="{w}"}} {s["weight"]}',
            f'nexus_gateway_drained{{worker="{w}"}} {int(s["drained"])}',
        ]
        hist = s["latency"]
        lines += [f'nexus_gateway_request_seconds_bucket{{worker="{w}",le="{b}"}} {n}'
                  for b, n in zip(LATENCY_BUCKETS, hist["buckets"])]
        lines += [
            f'nexus_gateway_request_seconds_bucket{{worker="{w}",le="+Inf"}} {hist["count"]}',
            f'nexus_gateway_request_seconds_sum{{worker="{w}"}} {hist["sum"]:.6f}',
            f'nexus_gateway_request_seconds_count{{worker="{w}"}} {hist["count"]}',
        ]
    return PlainTextResponse("\n".join(lines) + "\n")
