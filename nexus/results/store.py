"""Read-only view over what the real runs leave on disk.

Two layouts are read the same way:
  artifacts/ on the Brev box   agent-runs/<id>/, episodes/*.json, bfcl/, harness/audit.jsonl, load/
  evidence/ in the repo        agent/runs/<id>/, agent/episodes/*.json, baseline/*.json, heldout/*.json,
                               bfcl/, gates/summary.json, capacity/, batches.json

Roots are searched in order and the first copy of a run or episode wins, so put
the live artifacts directory before evidence/. Nothing here writes or imports
the fleet code: the UI server and the box operator app both use it.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from statistics import median

RUN_DIRS = ("agent-runs", "agent/runs")
EPISODE_DIRS = ("episodes", "agent/episodes")  # one record per file
EPISODE_BUNDLES = ("baseline", "heldout")  # a list of records per file
CAPACITY_DIRS = ("capacity", "load")
TERMINAL_EVENTS = {"run_completed", "run_failed"}
SAFE_ID = re.compile(r"^[A-Za-z0-9._~+:/-]+$")


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    break  # a half-written last line while a run is still appending
    return rows


def _safe(value: str) -> str:
    if not SAFE_ID.match(value) or ".." in value.split("/"):
        raise KeyError(f"bad id: {value}")
    return value


class ResultsStore:
    def __init__(self, roots: list[Path]) -> None:
        self.roots = [Path(r) for r in roots if r and Path(r).is_dir()]

    # ---- agent runs -------------------------------------------------------------------------
    def _run_dir(self, run_id: str) -> Path:
        _safe(run_id)
        for root in self.roots:
            for sub in RUN_DIRS:
                path = root / sub / run_id
                if (path / "events.jsonl").is_file():
                    return path
        raise KeyError(f"unknown run: {run_id}")

    def list_runs(self) -> list[dict]:
        seen: dict[str, dict] = {}
        for root in self.roots:
            for sub in RUN_DIRS:
                for log in (root / sub).glob("*/events.jsonl"):
                    run_id = log.parent.name
                    if run_id not in seen:
                        seen[run_id] = self._run_summary(run_id, _jsonl(log))
        return sorted(seen.values(), key=lambda r: r["started_at"] or "", reverse=True)

    @staticmethod
    def _run_summary(run_id: str, events: list[dict]) -> dict:
        first = events[0] if events else {}
        last = events[-1] if events else {}
        end = last if last.get("event_type") in TERMINAL_EVENTS else None
        trigger = first.get("payload", {}).get("trigger", {})
        return {
            "run_id": run_id, "started_at": first.get("timestamp"), "updated_at": last.get("timestamp"),
            "trigger": trigger.get("summary"), "resources": trigger.get("affected_resources", []),
            "events": len(events), "completed": end is not None,
            "outcome": end and end["event_type"], "state": (end or {}).get("payload", {}).get("state"),
            "steps": (end or {}).get("payload", {}).get("steps"),
            "tool_calls": (end or {}).get("payload", {}).get("tool_calls"),
        }

    def read_events(self, run_id: str, after: int = 0) -> list[dict]:
        """Envelopes with sequence > after. Sequences have no gaps, so a client can tail by them."""
        return [e for e in _jsonl(self._run_dir(run_id) / "events.jsonl") if e.get("sequence", 0) > after]

    def run_started_at(self, run_id: str) -> str | None:
        events = self.read_events(run_id)
        return events[0].get("timestamp") if events else None

    def read_evidence(self, run_id: str, evidence_id: str) -> dict:
        path = self._run_dir(run_id) / "evidence" / f"{_safe(evidence_id)}.json"
        if not path.is_file():
            raise KeyError(f"unknown evidence: {evidence_id}")
        return _json(path)

    # ---- episodes ---------------------------------------------------------------------------
    def _episodes(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        seen = set()

        def add(episode_id: str, record: dict, source: str) -> None:
            key = (record.get("at"), record.get("fault"), record.get("solver"))
            if key in seen:
                return
            seen.add(key)
            record = {**record, "heldout": bool(record.get("heldout")), "id": episode_id, "source": source,
                      "contaminated": "contaminated" in source}
            out[episode_id] = record

        for root in self.roots:
            for sub in EPISODE_DIRS:
                for path in sorted((root / sub).glob("*.json")):
                    add(f"{sub}/{path.stem}", _json(path), f"{sub}/{path.name}")
            for sub in EPISODE_BUNDLES:
                for path in sorted((root / sub).glob("*.json")):
                    data = _json(path)
                    if isinstance(data, list):
                        for i, record in enumerate(data):
                            add(f"{sub}/{path.stem}~{i}", record, f"{sub}/{path.name}")
        return out

    @staticmethod
    def _episode_row(e: dict) -> dict:
        action = e.get("action") or {}
        return {
            "id": e["id"], "fault": e.get("fault"), "solver": e.get("solver"), "heldout": e["heldout"],
            "at": e.get("at"), "terminal_state": e.get("terminal_state"), "success": e.get("success"),
            "false_verified": e.get("false_verified"), "solve_seconds": e.get("solve_seconds"),
            "run_id": e.get("run_id"), "action": action.get("action_id") or action.get("tool"),
            "target": action.get("target") or action.get("service"), "contaminated": e["contaminated"],
            "source": e["source"],
        }

    def list_episodes(self, solver: str | None = None, fault: str | None = None,
                      heldout: bool | None = None) -> list[dict]:
        rows = [self._episode_row(e) for e in self._episodes().values()
                if (solver is None or e.get("solver") == solver) and (fault is None or e.get("fault") == fault)
                and (heldout is None or e["heldout"] == heldout)]
        return sorted(rows, key=lambda r: r["at"] or "", reverse=True)

    def get_episode(self, episode_id: str) -> dict:
        episode = self._episodes().get(_safe(episode_id))
        if episode is None:
            raise KeyError(f"unknown episode: {episode_id}")
        return episode

    def episode_for_run(self, run_id: str) -> dict | None:
        for e in self._episodes().values():
            if e.get("run_id") == run_id or any(r.get("run_id") == run_id for r in e.get("rounds") or []):
                return e
        return None

    # ---- scoreboard -------------------------------------------------------------------------
    def batches(self) -> list[dict]:
        for root in self.roots:
            path = root / "batches.json"
            if path.is_file():
                return _json(path)
        return []

    def scoreboard(self) -> dict:
        """Successes per solver x fault, grouped by the named batches in batches.json.

        Episodes outside every batch land in an "unbatched" group per solver, so a run
        that is still going on the box shows up before anyone names its batch.
        Contaminated records are left out of every group.
        """
        episodes = [e for e in self._episodes().values() if not e["contaminated"]]
        groups = []
        claimed = set()
        for batch in self.batches():
            members = [e for e in episodes if e.get("solver") == batch["solver"]
                       and batch["from"] <= (e.get("at") or "") <= batch["to"]
                       and (batch.get("heldout") is None or e["heldout"] == batch["heldout"])]
            claimed.update(e["id"] for e in members)
            groups.append({**batch, **self._cells(members)})
        for solver in sorted({e.get("solver") for e in episodes if e["id"] not in claimed}):
            members = [e for e in episodes if e["id"] not in claimed and e.get("solver") == solver]
            groups.append({"id": f"unbatched-{solver}", "label": "Not in a named batch", "solver": solver,
                           "from": min(e["at"] for e in members), "to": max(e["at"] for e in members),
                           **self._cells(members)})
        return {"batches": groups}

    @staticmethod
    def _cells(members: list[dict]) -> dict:
        def cell(rows: list[dict]) -> dict:
            times = [r["solve_seconds"] for r in rows if r.get("solve_seconds") is not None]
            return {"success": sum(bool(r.get("success")) for r in rows), "total": len(rows),
                    "false_verified": sum(bool(r.get("false_verified")) for r in rows),
                    "median_s": round(median(times), 1) if times else None}
        faults = sorted({e.get("fault") for e in members})
        return {"faults": {f: cell([e for e in members if e.get("fault") == f]) for f in faults},
                "total": cell(members)}

    # ---- other evaluation records ------------------------------------------------------------
    def bfcl(self) -> list[dict]:
        latest: dict[str, dict] = {}
        for root in self.roots:
            for path in (root / "bfcl").glob("*.json"):
                d = _json(path)
                label = d.get("label", path.stem)
                if label not in latest or d.get("at", "") > latest[label].get("at", ""):
                    latest[label] = {k: v for k, v in d.items() if k != "results"} | {"file": path.name}
        return sorted(latest.values(), key=lambda d: -(d.get("tool_calling_score") or 0))

    def gates(self) -> dict:
        for root in self.roots:
            path = root / "gates" / "summary.json"
            if path.is_file():
                return _json(path)
        return {}

    def capacity_files(self) -> list[str]:
        return sorted({p.stem for root in self.roots for sub in CAPACITY_DIRS for p in (root / sub).glob("*.csv")})

    def capacity(self, name: str) -> dict:
        """A guidellm CSV: three header rows (group, name, unit) flattened into one column name."""
        _safe(name)
        for root in self.roots:
            for sub in CAPACITY_DIRS:
                path = root / sub / f"{name}.csv"
                if path.is_file():
                    with path.open(encoding="utf-8", newline="") as fh:
                        rows = list(csv.reader(fh))
                    head, body = rows[:3], rows[3:]
                    columns = [" · ".join(p for p in dict.fromkeys(h[i] for h in head if i < len(h)) if p)
                               for i in range(len(head[0]))] if head else []
                    return {"name": name, "columns": columns, "rows": body}
        raise KeyError(f"unknown capacity file: {name}")

    def audit(self, limit: int = 50) -> list[dict]:
        for root in self.roots:
            path = root / "harness" / "audit.jsonl"
            if path.is_file():
                return _jsonl(path)[-limit:][::-1]
        return []
