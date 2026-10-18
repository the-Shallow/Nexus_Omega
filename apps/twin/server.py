"""Nexus Ω digital twin server.

Runs the SimPy twin against the wall clock, streams frames to the 3D view over
a WebSocket, and exposes faults, actions, rollback, what-if previews and
Prometheus metrics over HTTP.

    uvicorn apps.twin.server:app --port 8765
"""

from __future__ import annotations

import asyncio
import json
import os
import pickle
import time
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from nexus.certificate import morning_summary, notification_preview
from nexus.doctors import DoctorManager
from nexus.simulator import Twin, actions, faults, telemetry, whatif

STATIC = Path(__file__).parent / "static"
WEB_DIST = Path(__file__).resolve().parents[1] / "web" / "dist"  # React app (apps/web), built with `npm run build`
CERT_DIR = Path(__file__).resolve().parents[2] / "artifacts" / "certificates"
TICK_S = 0.05
FRAME_S = 0.1
WARMUP_S = 90.0


class Runtime:
    def __init__(self) -> None:
        self.doctors = DoctorManager(CERT_DIR)
        self.reset()

    def reset(self, seed: int | None = None) -> None:
        # Warm the new twin up before publishing it, so the stream loop never
        # advances a half-built simulation.
        twin = Twin(seed=seed)
        twin.advance(WARMUP_S)
        twin.log("info", f"digital twin online · profile {twin.profile['name']}", None, "boot")
        self.doctors.reset()
        self.doctor_rev = ""
        self.preview_task: asyncio.Task | None = None
        self.speed = 1.0
        self.paused = False
        self.last_seq = twin.state.event_seq
        self.twin = twin


rt = Runtime()
clients: set[WebSocket] = set()
pool: ProcessPoolExecutor | None = None


async def _broadcast(message: str) -> None:
    dead = []
    for ws in clients:
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def _doctor_preview(run) -> None:
    """Fulfil a doctor's PRECHECK request on the process pool, off the event loop."""
    twin = rt.twin
    blob, now = pickle.dumps(twin.state), twin.now
    candidates = whatif.candidate_set(twin, run.preview_request)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, lambda: whatif.preview(twin.profile, blob, now, candidates, 180.0, executor=pool))
    if twin is rt.twin:
        run.preview_result = result


def _doctor_snapshot() -> dict | None:
    run = rt.doctors.active or (rt.doctors.runs[-1] if rt.doctors.runs else None)
    return run.snapshot() if run else None


async def _run() -> None:
    last_tick = last_frame = time.monotonic()
    while True:
        await asyncio.sleep(TICK_S)
        now = time.monotonic()
        if not rt.paused:
            rt.twin.advance(min(now - last_tick, 0.25) * rt.speed)
            rt.doctors.tick(rt.twin)
            run = rt.doctors.active
            if run and run.preview_request is not None and run.preview_result is None and (rt.preview_task is None or rt.preview_task.done()):
                rt.preview_task = asyncio.create_task(_doctor_preview(run))
        last_tick = now
        if now - last_frame >= FRAME_S:
            last_frame = now
            frame = telemetry.frame(rt.twin, rt.last_seq)
            rt.last_seq = frame["seq"]
            snap = _doctor_snapshot()
            rev = f"{snap['id']}:{len(snap['events'])}:{snap['awaiting_approval']}:{snap['usage']}" if snap else ""
            if rev != rt.doctor_rev:
                rt.doctor_rev = rev
                frame["doctor"] = snap
            frame["doctors"] = {"enabled": rt.doctors.enabled, "autopilot": rt.doctors.autopilot, "active": rt.doctors.active.id if rt.doctors.active else None}
            if clients:
                frame["speed"], frame["paused"] = rt.speed, rt.paused
                await _broadcast(json.dumps(frame, separators=(",", ":")))


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    pool = ProcessPoolExecutor(max_workers=min(6, os.cpu_count() or 2))
    task = asyncio.create_task(_run())
    yield
    task.cancel()
    pool.shutdown(cancel_futures=True)


app = FastAPI(title="Nexus Ω digital twin", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class FaultRequest(BaseModel):
    kind: str
    target: str | None = None


class ActionRequest(BaseModel):
    kind: str
    args: dict = {}


class RollbackRequest(BaseModel):
    token: str


class PreviewRequest(BaseModel):
    candidates: list[dict] | None = None
    horizon: float = 180.0


class ControlRequest(BaseModel):
    speed: float | None = None
    paused: bool | None = None
    reset: bool = False
    seed: int | None = None


# Endpoints that read or change the twin are `async def` so they run on the event
# loop, between ticks of _run(), instead of racing it from a worker thread.
def _guard(fn, *args):
    try:
        return fn(*args)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc).strip("'\"")) from exc


@app.get("/")
def index() -> FileResponse:
    """The React platform when it is built, otherwise the static twin view."""
    built = WEB_DIST / "index.html"
    return FileResponse(built if built.exists() else STATIC / "index.html")


@app.get("/classic")
def classic() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/assets/{path:path}")
def web_asset(path: str) -> FileResponse:
    root = (WEB_DIST / "assets").resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target)


@app.get("/api/topology")
async def get_topology() -> dict:
    return telemetry.topology(rt.twin)


@app.get("/api/state")
async def get_state() -> dict:
    s = rt.twin.state
    return {"t": rt.twin.now, "kpi": s.series[-1] if s.series else rt.twin.kpis(), "faults": list(s.faults.values())}


@app.get("/api/faults")
def get_faults() -> list[dict]:
    return faults.catalog()


@app.post("/api/faults")
async def post_fault(req: FaultRequest) -> dict:
    return _guard(faults.inject, rt.twin, req.kind, req.target)


@app.post("/api/faults/{fid}/repair")
async def repair_fault(fid: str) -> dict:
    return _guard(faults.repair, rt.twin, fid)


@app.get("/api/actions")
def get_actions() -> list[str]:
    return list(actions.KINDS)


@app.post("/api/actions")
async def post_action(req: ActionRequest) -> dict:
    return _guard(actions.apply_action, rt.twin, req.kind, req.args)


@app.post("/api/rollback")
async def post_rollback(req: RollbackRequest) -> dict:
    return _guard(actions.rollback, rt.twin, req.token)


@app.get("/api/candidates")
async def get_candidates() -> list[dict]:
    return whatif.candidate_set(rt.twin)


@app.post("/api/preview")
async def post_preview(req: PreviewRequest) -> dict:
    """simulate_action: fork the twin now and compare candidate actions over the horizon."""
    twin = rt.twin
    blob = pickle.dumps(twin.state)  # snapshot on the event loop, before the twin advances again
    candidates = req.candidates or whatif.candidate_set(twin)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: whatif.preview(twin.profile, blob, twin.now, candidates, req.horizon, executor=pool)
    )


@app.post("/api/control")
async def post_control(req: ControlRequest) -> dict:
    if req.reset:
        rt.reset(req.seed)
    if req.speed is not None:
        rt.speed = max(0.1, min(req.speed, 20.0))
    if req.paused is not None:
        rt.paused = req.paused
    return {"speed": rt.speed, "paused": rt.paused, "t": rt.twin.now}


class DoctorConfig(BaseModel):
    autopilot: bool | None = None
    enabled: bool | None = None


class ApprovalRequest(BaseModel):
    choice: str  # a candidate id, "recommended", or "reject"


@app.get("/api/doctors")
async def get_doctors() -> dict:
    d = rt.doctors
    return {
        "enabled": d.enabled,
        "autopilot": d.autopilot,
        "active": _doctor_snapshot(),
        "runs": [{"id": r.id, "doctor": r.doctor, "state": r.state, "incident": r.incident.get("title"), "certificate_id": r.certificate and r.certificate["certificate_id"]} for r in d.runs],
    }


@app.post("/api/doctors/config")
async def post_doctor_config(req: DoctorConfig) -> dict:
    if req.autopilot is not None:
        rt.doctors.autopilot = req.autopilot
        if rt.doctors.active:
            rt.doctors.active.autopilot = req.autopilot
    if req.enabled is not None:
        rt.doctors.enabled = req.enabled
    rt.doctor_rev = ""
    return {"enabled": rt.doctors.enabled, "autopilot": rt.doctors.autopilot}


@app.get("/api/doctors/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    for r in rt.doctors.runs:
        if r.id == run_id:
            return r.snapshot()
    raise HTTPException(404, f"unknown run: {run_id}")


@app.post("/api/doctors/runs/{run_id}/approve")
async def approve_run(run_id: str, req: ApprovalRequest) -> dict:
    run = next((r for r in rt.doctors.runs if r.id == run_id), None)
    if run is None or not run.awaiting_approval:
        raise HTTPException(400, "run is not awaiting approval")
    run.approval_choice = run.precheck["recommended"] if req.choice == "recommended" else req.choice
    rt.doctor_rev = ""
    return {"run": run_id, "choice": run.approval_choice}


@app.get("/api/certificates")
def list_certificates() -> list[dict]:
    return rt.doctors.store.list()


@app.get("/api/certificates/{cert_id}")
def get_certificate(cert_id: str, download: bool = False):
    cert = rt.doctors.store.get(cert_id)
    if cert is None:
        raise HTTPException(404, f"unknown certificate: {cert_id}")
    headers = {"Content-Disposition": f'attachment; filename="{cert_id}.json"'} if download else None
    return JSONResponse(cert, headers=headers)


@app.get("/api/certificates/{cert_id}/summary")
def certificate_summary(cert_id: str) -> dict:
    cert = rt.doctors.store.get(cert_id)
    if cert is None:
        raise HTTPException(404, f"unknown certificate: {cert_id}")
    return {"certificate": cert, "notification": notification_preview(cert), "morning": morning_summary(cert)}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(telemetry.prometheus(rt.twin), media_type="text/plain; version=0.0.4")


@app.websocket("/ws")
async def stream(ws: WebSocket) -> None:
    await ws.accept()
    s = rt.twin.state
    # source tells the view where frames come from: "twin" (simulated) or, later, "live".
    hello = {"type": "hello", "source": "twin", "topology": telemetry.topology(rt.twin), "events": list(s.events)[-40:]}
    await ws.send_text(json.dumps(hello))
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # the view is read-only on this channel; keep the socket open
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TWIN_PORT", "8765")))
