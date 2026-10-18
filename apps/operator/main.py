"""Operator API on the Brev box: read run records, and start named faults as episodes.

This is the "Break it" endpoint the UI was waiting on (web/README.md, "Coming from E2").
It is separate from the agent's environment API (:8120) and uses its own token,
so the agent can never reach it. A fault can only be chosen by name from
nexus.eval.episode.FAULTS; there is no free-form injection. One job runs at a
time, and the executor's mutation lock still guards every repair action.

    uvicorn apps.operator.main:app --host 127.0.0.1 --port 8130
"""
from __future__ import annotations

import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

from nexus.results import ResultsStore
from nexus.results.routes import results_router

ROOT = Path(__file__).resolve().parents[2]
TOKEN = os.environ.get("NEXUS_OPERATOR_TOKEN", "")
store = ResultsStore([ROOT / "artifacts", ROOT / "evidence"])

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="episode")


def runner():
    """The episode module, imported lazily: it pulls in the fleet code (manager, fault injectors)."""
    from nexus.eval import episode

    return episode


def require_operator(request: Request) -> None:
    if not TOKEN:
        raise HTTPException(503, "NEXUS_OPERATOR_TOKEN is not configured")
    if request.headers.get("authorization") != f"Bearer {TOKEN}":
        raise HTTPException(401, "missing or invalid token")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _after(stamp: str | None, start: str) -> bool:
    try:
        return stamp is not None and datetime.fromisoformat(stamp) >= datetime.fromisoformat(start)
    except ValueError:
        return False


def job_view(job: dict) -> dict:
    # With one job at a time, every agent run that started after the job did belongs to it.
    run_ids = [r["run_id"] for r in reversed(store.list_runs()) if _after(r["started_at"], job["started_at"])] \
        if job["solver"] == "agent" and job["started_at"] else []
    return {**job, "run_ids": run_ids}


app = FastAPI(title="Nexus Ω operator", dependencies=[Depends(require_operator)])
app.include_router(results_router(store))


class JobRequest(BaseModel):
    fault: str
    solver: str = "rules"


@app.get("/faults")
def faults() -> list[dict]:
    ep = runner()
    return [{"name": name, "heldout": f.get("set") is not None, "fix": f.get("fix", []), "drain": f.get("drain", []),
             "expect_action": f.get("expect_action", True)} for name, f in ep.FAULTS.items()]


def _run(job_id: str) -> None:
    job = jobs[job_id]
    job.update(state="running", started_at=now())
    try:
        record = runner().run_episode(job["fault"], job["solver"])
        job.update(state="done", episode={k: record.get(k) for k in
                                          ("fault", "solver", "at", "terminal_state", "success",
                                           "false_verified", "solve_seconds", "run_id")})
    except Exception as exc:  # noqa: BLE001 - a failed job is reported, not raised into the pool
        job.update(state="failed", error=f"{type(exc).__name__}: {exc}"[:500])
    finally:
        job["ended_at"] = now()


@app.post("/jobs", status_code=202)
def start_job(req: JobRequest) -> dict:
    ep = runner()
    if req.fault not in ep.FAULTS:
        raise HTTPException(400, f"unknown fault: {req.fault}; choose one of {sorted(ep.FAULTS)}")
    if req.solver not in ep.SOLVERS:
        raise HTTPException(400, f"unknown solver: {req.solver}; choose one of {sorted(ep.SOLVERS)}")
    with jobs_lock:
        busy = next((j for j in jobs.values() if j["state"] in ("queued", "running")), None)
        if busy:
            raise HTTPException(409, f"job {busy['id']} ({busy['fault']}) is still {busy['state']}")
        job_id = f"job-{uuid.uuid4().hex[:8]}"
        jobs[job_id] = {"id": job_id, "fault": req.fault, "solver": req.solver, "state": "queued",
                        "queued_at": now(), "started_at": None, "ended_at": None, "episode": None, "error": None}
    worker.submit(_run, job_id)
    return {"job_id": job_id}


@app.get("/jobs")
def list_jobs() -> list[dict]:
    return [job_view(j) for j in sorted(jobs.values(), key=lambda j: j["queued_at"], reverse=True)]


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    if job_id not in jobs:
        raise HTTPException(404, f"unknown job: {job_id}")
    return job_view(jobs[job_id])


@app.get("/health")
def health() -> dict:
    return {"ok": True, "active_job": next((j["id"] for j in jobs.values() if j["state"] in ("queued", "running")),
                                            None)}
