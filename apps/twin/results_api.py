"""Real-run routes on the UI server: results, a live run stream, and the Break it passthrough.

    /api/results/*            read-only records (nexus.results.routes), from local files or the box
    /api/runs/{id}/stream     Server-Sent Events: a run's trail, adapted to the UI's RunEvent shape
    /api/live/status          which box sources are reachable
    /api/live/faults|break|jobs   the box operator app, with its token added here

Results come from the box operator app when NEXUS_OPERATOR_URL is set, otherwise
from ARTIFACTS_DIR (if given) and the committed evidence/ folder.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from apps.twin import live
from nexus.results import ResultsStore, RunAdapter, snapshot
from nexus.results.routes import results_router

ROOT = Path(__file__).resolve().parents[2]
store = ResultsStore([Path(p) for p in [os.environ.get("ARTIFACTS_DIR")] if p] + [ROOT / "evidence"])
POLL_S = 0.5
KEEPALIVE_S = 15.0
EPISODE_WAIT_S = 240.0  # the executor's restart + hidden canary (~75 s) and the referee run after the trail ends
TERMINAL_EVENTS = {"run_completed", "run_failed"}

router = APIRouter()


# ---- where run records come from -------------------------------------------------------------
class LocalSource:
    async def events(self, run_id: str, after: int = 0) -> list[dict]:
        return store.read_events(run_id, after)

    async def episode(self, run_id: str) -> dict | None:
        return store.episode_for_run(run_id)

    async def snapshot(self, run_id: str) -> dict | None:
        try:
            return snapshot(run_id, store.read_events(run_id), store.episode_for_run(run_id))
        except KeyError:
            return None


class RemoteSource:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client

    async def _get(self, path: str, **params):
        resp = await self.client.get(f"{live.OPERATOR_URL}{path}", params=params, headers=live.operator_headers(),
                                     timeout=5.0)
        if resp.status_code == 404:
            raise KeyError(resp.json().get("detail", path))
        resp.raise_for_status()
        return resp.json()

    async def events(self, run_id: str, after: int = 0) -> list[dict]:
        return await self._get(f"/runs/{run_id}/events", after=after)

    async def episode(self, run_id: str) -> dict | None:
        try:
            return await self._get(f"/runs/{run_id}/episode")
        except KeyError:
            return None

    async def snapshot(self, run_id: str) -> dict | None:
        try:
            return await self._get(f"/runs/{run_id}", view="snapshot")
        except (KeyError, httpx.HTTPError):
            return None


def source(client: httpx.AsyncClient):
    return RemoteSource(client) if live.OPERATOR_URL else LocalSource()


# ---- /api/results ---------------------------------------------------------------------------
if live.OPERATOR_URL:
    # The scoreboard is the curated result: always built from the committed evidence/ here, so
    # the charts don't depend on the box's checkout. Runs, events and episodes still come from the box.
    @router.get("/api/results/scoreboard")
    def results_scoreboard() -> dict:
        return store.scoreboard()

    @router.get("/api/results/{path:path}")
    async def results_passthrough(path: str, request: Request) -> JSONResponse:
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.get(f"{live.OPERATOR_URL}/{path}", params=request.query_params,
                                        headers=live.operator_headers(), timeout=10.0)
            except httpx.HTTPError as exc:
                raise HTTPException(502, f"operator app unreachable: {type(exc).__name__}") from exc
        return JSONResponse(resp.json(), status_code=resp.status_code)
else:
    router.include_router(results_router(store, prefix="/api/results"))


# ---- /api/runs/{id}/stream ------------------------------------------------------------------
def _sse(data: dict, event: str | None = None, event_id: int | None = None) -> str:
    head = (f"id: {event_id}\n" if event_id is not None else "") + (f"event: {event}\n" if event else "")
    return f"{head}data: {json.dumps(data, separators=(',', ':'))}\n\n"


def _recent(stamp: str | None) -> bool:
    try:
        return time.time() - datetime.fromisoformat(stamp).timestamp() < EPISODE_WAIT_S
    except (TypeError, ValueError):
        return False


@router.get("/api/runs/{run_id}/stream")
async def stream_run(run_id: str, request: Request, last_event_id: str | None = Header(None),
                     after: int = 0) -> StreamingResponse:
    """Replay a run from the start, then follow it until it ends and the referee has scored it.

    Each message carries the raw envelope and the RunEvents it maps to; its SSE id is the
    envelope's sequence, so a reconnecting EventSource resumes where it stopped. Ends with an
    `end` event holding the full DoctorSnapshot.
    """
    resume = int(last_event_id) if last_event_id and last_event_id.isdigit() else after
    client = httpx.AsyncClient()
    src = source(client)
    try:
        first = await src.events(run_id, 0)
    except KeyError as exc:
        await client.aclose()
        raise HTTPException(404, str(exc).strip("'\"")) from exc

    async def gen():
        adapter = RunAdapter(run_id)
        seq, pending, done, quiet = 0, first, False, 0.0
        try:
            while True:
                for envelope in pending:
                    run_events = adapter.feed(envelope)
                    seq = envelope.get("sequence", seq)
                    done = done or envelope.get("event_type") in TERMINAL_EVENTS
                    if seq > resume:
                        yield _sse({"event": envelope, "run_events": run_events}, event_id=seq)
                if done or await request.is_disconnected():
                    break
                await asyncio.sleep(POLL_S)
                quiet += POLL_S
                if quiet >= KEEPALIVE_S:
                    quiet = 0.0
                    yield ": keep-alive\n\n"
                pending = await src.events(run_id, seq)
                if pending:
                    quiet = 0.0
            if not done:
                return
            # The trail ends when the agent hands its repair to the executor; the referee's verdict
            # comes later in the episode record. Wait for it only if the run just finished.
            episode = await src.episode(run_id)
            last_stamp = (pending[-1] if pending else first[-1] if first else {}).get("timestamp")
            deadline = time.monotonic() + EPISODE_WAIT_S
            while episode is None and _recent(last_stamp) and time.monotonic() < deadline:
                if await request.is_disconnected():
                    return
                yield ": waiting for the referee\n\n"
                await asyncio.sleep(2.0)
                episode = await src.episode(run_id)
            if episode is not None:
                adapter.episode = episode
                yield _sse({"event": None, "run_events": adapter.finish()}, event="referee")
            yield _sse(adapter.snapshot(), event="end")
        finally:
            await client.aclose()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---- /api/live --------------------------------------------------------------------------------
class BreakRequest(BaseModel):
    fault: str
    solver: str = "rules"


async def _operator(method: str, path: str, body: dict | None = None) -> JSONResponse:
    if not live.OPERATOR_URL:
        raise HTTPException(503, "live fleet not connected: set NEXUS_OPERATOR_URL and NEXUS_OPERATOR_TOKEN")
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.request(method, f"{live.OPERATOR_URL}{path}", json=body,
                                        headers=live.operator_headers(), timeout=10.0)
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"operator app unreachable: {type(exc).__name__}") from exc
    return JSONResponse(resp.json(), status_code=resp.status_code)


@router.get("/api/live/status")
async def live_status() -> dict:
    return {**await live.status(), "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


@router.get("/api/live/faults")
async def live_faults() -> JSONResponse:
    return await _operator("GET", "/faults")


@router.post("/api/live/break")
async def live_break(req: BreakRequest) -> JSONResponse:
    return await _operator("POST", "/jobs", req.model_dump())


@router.get("/api/live/jobs")
async def live_jobs() -> JSONResponse:
    return await _operator("GET", "/jobs")


@router.get("/api/live/jobs/{job_id}")
async def live_job(job_id: str) -> JSONResponse:
    return await _operator("GET", f"/jobs/{job_id}")


async def live_doctor(run_id: str) -> dict | None:
    """The adapted snapshot of the active job's run, for frame['doctor'] on the live socket."""
    async with httpx.AsyncClient() as client:
        return await source(client).snapshot(run_id)
