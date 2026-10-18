"""The read-only results routes, shared by the UI server and the box operator app.

Both mount the same paths, so the UI server can either serve them from local
files or pass them straight through to the box:

    UI server   /api/results/<path>   ->  local evidence/, or  operator /<path>
    operator    /<path>               ->  artifacts/ (+ evidence/) on the box
"""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, HTTPException, Query

from nexus.results.adapt import snapshot
from nexus.results.store import ResultsStore


def _found(fn: Callable, *args):
    try:
        return fn(*args)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\"")) from exc


def results_router(store: ResultsStore, **kwargs) -> APIRouter:
    r = APIRouter(**kwargs)

    @r.get("/scoreboard")
    def scoreboard() -> dict:
        return store.scoreboard()

    @r.get("/episodes")
    def episodes(solver: str | None = None, fault: str | None = None, heldout: bool | None = None) -> list[dict]:
        return store.list_episodes(solver, fault, heldout)

    @r.get("/episodes/{episode_id:path}")
    def episode(episode_id: str) -> dict:
        return _found(store.get_episode, episode_id)

    @r.get("/runs")
    def runs() -> list[dict]:
        return store.list_runs()

    @r.get("/runs/{run_id}")
    def run(run_id: str, view: str = Query("snapshot", pattern="^(snapshot|raw)$")) -> dict:
        events = _found(store.read_events, run_id)
        if view == "raw":
            return {"run_id": run_id, "events": events}
        return snapshot(run_id, events, store.episode_for_run(run_id))

    @r.get("/runs/{run_id}/events")
    def run_events(run_id: str, after: int = 0) -> list[dict]:
        return _found(store.read_events, run_id, after)

    @r.get("/runs/{run_id}/episode")
    def run_episode(run_id: str) -> dict:
        episode = store.episode_for_run(run_id)
        if episode is None:
            raise HTTPException(404, f"no episode recorded for {run_id} yet")
        return episode

    @r.get("/runs/{run_id}/evidence/{evidence_id}")
    def run_evidence(run_id: str, evidence_id: str) -> dict:
        return _found(store.read_evidence, run_id, evidence_id)

    @r.get("/bfcl")
    def bfcl() -> list[dict]:
        return store.bfcl()

    @r.get("/gates")
    def gates() -> dict:
        return store.gates()

    @r.get("/capacity")
    def capacity_files() -> list[str]:
        return store.capacity_files()

    @r.get("/capacity/{name}")
    def capacity(name: str) -> dict:
        return _found(store.capacity, name)

    @r.get("/audit")
    def audit(limit: int = Query(50, ge=1, le=500)) -> list[dict]:
        return store.audit(limit)

    return r
