"""Gateway admin API in front of the HAProxy data plane.

HAProxy (runtime/compose/haproxy.cfg) carries inference traffic on :8100. This
service exposes the admin endpoints the executor uses to drain, undrain or
reweight a worker, and applies them through HAProxy's runtime API, so changes
take effect live without a reload. Route weights use the 0-10 scale the
executor expects (1.0 = HAProxy weight 10).

NEXUS_HAPROXY_RUNTIME is the runtime socket (default haproxy:9999).
NEXUS_ADMIN_TOKEN, when set, is required as a bearer token on /admin/*.
"""
from __future__ import annotations

import csv
import io
import os
import socket

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

BACKEND = "vllm"
RUNTIME = os.environ.get("NEXUS_HAPROXY_RUNTIME", "haproxy:9999")
ADMIN_TOKEN = os.environ.get("NEXUS_ADMIN_TOKEN", "")
app = FastAPI(title="Nexus Ω gateway admin")


def require_admin(request: Request) -> None:
    if ADMIN_TOKEN and request.headers.get("authorization") != f"Bearer {ADMIN_TOKEN}":
        raise HTTPException(401, "admin token required")


def runtime(command: str) -> str:
    host, port = RUNTIME.rsplit(":", 1)
    try:
        with socket.create_connection((host, int(port)), timeout=5) as conn:
            conn.sendall(command.encode() + b"\n")
            chunks = []
            while chunk := conn.recv(65536):
                chunks.append(chunk)
    except OSError as exc:
        raise HTTPException(502, f"HAProxy runtime API unreachable: {exc}") from exc
    return b"".join(chunks).decode()


def workers() -> dict[str, dict]:
    text = runtime("show stat").lstrip("# ")
    rows = [r for r in csv.DictReader(io.StringIO(text))
            if r["pxname"] == BACKEND and r["svname"] not in ("FRONTEND", "BACKEND")]
    out = {}
    for r in rows:
        status = r["status"].upper()
        errors = sum(int(r[k] or 0) for k in ("hrsp_5xx", "eresp", "econ"))
        out[r["svname"]] = {
            "weight": int(r.get("uweight") or r["weight"] or 0) / 10,
            "drained": "DRAIN" in status or "MAINT" in status,
            "status": r["status"],
            "requests": int(r["stot"] or 0),
            "errors": errors,
            "active": int(r["scur"] or 0),
            "queued": int(r["qcur"] or 0),
        }
    return out


def get_worker(worker_id: str) -> dict:
    current = workers()
    if worker_id not in current:
        raise HTTPException(404, f"unknown worker '{worker_id}'")
    return current[worker_id]


def set_server(worker_id: str, setting: str) -> None:
    reply = runtime(f"set server {BACKEND}/{worker_id} {setting}").strip()
    if reply:
        raise HTTPException(502, f"HAProxy rejected '{setting}': {reply[:200]}")


class WeightBody(BaseModel):
    weight: float = Field(ge=0, le=10)


@app.get("/admin/workers", dependencies=[Depends(require_admin)])
async def list_workers():
    return workers()


@app.post("/admin/workers/{worker_id}/weight", dependencies=[Depends(require_admin)])
async def set_weight(worker_id: str, body: WeightBody):
    before = get_worker(worker_id)["weight"]
    set_server(worker_id, f"weight {round(body.weight * 10)}")
    return {"worker": worker_id, "before": before, "after": body.weight}


@app.post("/admin/workers/{worker_id}/drain", dependencies=[Depends(require_admin)])
async def drain(worker_id: str):
    before = get_worker(worker_id)["drained"]
    set_server(worker_id, "state drain")
    return {"worker": worker_id, "drained_before": before, "drained": True}


@app.post("/admin/workers/{worker_id}/undrain", dependencies=[Depends(require_admin)])
async def undrain(worker_id: str):
    before = get_worker(worker_id)["drained"]
    set_server(worker_id, "state ready")
    return {"worker": worker_id, "drained_before": before, "drained": False}


@app.get("/health")
async def health():
    return {"ok": True, "runtime": RUNTIME}
