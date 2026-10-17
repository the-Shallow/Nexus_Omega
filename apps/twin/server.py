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
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from nexus.simulator import Twin, actions, faults, telemetry, whatif

STATIC = Path(__file__).parent / "static"
TICK_S = 0.05
FRAME_S = 0.1
WARMUP_S = 90.0


class Runtime:
    def __init__(self) -> None:
        self.reset()

    def reset(self, seed: int | None = None) -> None:
        self.twin = Twin(seed=seed)
        self.twin.advance(WARMUP_S)
        self.speed = 1.0
        self.paused = False
        self.last_seq = self.twin.state.event_seq
        self.twin.log("info", f"digital twin online · profile {self.twin.profile['name']}", None, "boot")


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


async def _run() -> None:
    last_tick = last_frame = time.monotonic()
    while True:
        await asyncio.sleep(TICK_S)
        now = time.monotonic()
        if not rt.paused:
            rt.twin.advance(min(now - last_tick, 0.25) * rt.speed)
        last_tick = now
        if now - last_frame >= FRAME_S:
            last_frame = now
            frame = telemetry.frame(rt.twin, rt.last_seq)
            rt.last_seq = frame["seq"]
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


def _guard(fn, *args):
    try:
        return fn(*args)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc).strip("'\"")) from exc


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/topology")
def get_topology() -> dict:
    return telemetry.topology(rt.twin)


@app.get("/api/state")
def get_state() -> dict:
    s = rt.twin.state
    return {"t": rt.twin.now, "kpi": s.series[-1] if s.series else rt.twin.kpis(), "faults": list(s.faults.values())}


@app.get("/api/faults")
def get_faults() -> list[dict]:
    return faults.catalog()


@app.post("/api/faults")
def post_fault(req: FaultRequest) -> dict:
    return _guard(faults.inject, rt.twin, req.kind, req.target)


@app.post("/api/faults/{fid}/repair")
def repair_fault(fid: str) -> dict:
    return _guard(faults.repair, rt.twin, fid)


@app.get("/api/actions")
def get_actions() -> list[str]:
    return list(actions.KINDS)


@app.post("/api/actions")
def post_action(req: ActionRequest) -> dict:
    return _guard(actions.apply_action, rt.twin, req.kind, req.args)


@app.post("/api/rollback")
def post_rollback(req: RollbackRequest) -> dict:
    return _guard(actions.rollback, rt.twin, req.token)


@app.get("/api/candidates")
def get_candidates() -> list[dict]:
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
def post_control(req: ControlRequest) -> dict:
    if req.reset:
        rt.reset(req.seed)
    if req.speed is not None:
        rt.speed = max(0.1, min(req.speed, 20.0))
    if req.paused is not None:
        rt.paused = req.paused
    return {"speed": rt.speed, "paused": rt.paused, "t": rt.twin.now}


@app.get("/metrics")
def metrics() -> PlainTextResponse:
    return PlainTextResponse(telemetry.prometheus(rt.twin), media_type="text/plain; version=0.0.4")


@app.websocket("/ws")
async def stream(ws: WebSocket) -> None:
    await ws.accept()
    s = rt.twin.state
    await ws.send_text(json.dumps({"type": "hello", "topology": telemetry.topology(rt.twin), "events": list(s.events)[-40:]}))
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
