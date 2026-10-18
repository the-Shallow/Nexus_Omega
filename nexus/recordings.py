"""Recorded fleet runs: the Nemotron agent's trails on the live Brev fleet.

Each run is the agent's own record (``runs/<run_id>/events.jsonl``, the evidence
index ``evidence.jsonl`` and the evidence contents ``evidence/ev-NNN.json``). The
outcome comes from a separate episode (``episodes/*.json``): its terminal state is
the executor's verdict on the agent's plan, and ``success`` / ``false_verified``
are the referee's independent score. The agent never declares its own success.

Episodes that record a ``run_id`` link to their run directly. Older episodes are
paired by time: runs, oldest first, each take the first unused episode that
finished at or after the run started and within 15 minutes of it.

The root is ``$NEXUS_RECORDINGS_DIR`` if set, else ``<repo>/evidence/agent``.
"""

from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = REPO / "evidence" / "agent"
AGENT_PROFILE = REPO / "runtime" / "profiles" / "lightning-nvfp4.agent.json"  # the profile the agent ran with
RUN_ID = re.compile(r"^run-[0-9a-f]{6,}$")
EVIDENCE_FILE = re.compile(r"^ev-(\d+)$")
PAIR_WINDOW = timedelta(minutes=15)
TITLES = {
    "vllm-32926": "Silent tool-call failure",
    "net-latency-b": "Link latency on worker b",
    "net-blackhole-b": "Link blackhole on worker b",
    "kill-b": "Worker b killed",
    "compound-latb-32926a": "Link latency on b + silent tool-call failure on a",
    "capacity-b": "Concurrency cap on worker b",
    "tools-stripped-a": "Tools template stripped on worker a",
    "noop": "No fault (control episode)",
}
NO_MODEL = "Nemotron (model not recorded)"

# root -> (file signature, {run_id: detail}); rebuilt whenever a file changes.
_cache: dict[str, tuple[tuple, dict[str, dict]]] = {}


def recordings_root(root: Path | None = None) -> Path:
    if root is not None:
        return Path(root)
    env = os.environ.get("NEXUS_RECORDINGS_DIR")
    return Path(env) if env else DEFAULT_ROOT


def list_recordings(root: Path | None = None) -> list[dict]:
    """Summaries of every recorded run, newest first. [] when there are none."""
    return [copy.deepcopy(d["summary"]) for d in _load(recordings_root(root)).values()]


def get_recording(run_id: str, root: Path | None = None) -> dict | None:
    """Full detail of one run, or None for an id that was not found by scanning the runs."""
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        return None
    detail = _load(recordings_root(root)).get(run_id)
    return copy.deepcopy(detail) if detail is not None else None


# --------------------------------------------------------------------- loading


def _load(root: Path) -> dict[str, dict]:
    key = str(root.resolve())
    sig = _signature(root)
    hit = _cache.get(key)
    if hit is None or hit[0] != sig:
        hit = (sig, _scan(root))
        _cache[key] = hit
    return hit[1]


def _signature(root: Path) -> tuple:
    entries = []
    for base in (root / "runs", root / "episodes"):
        if base.is_dir():
            for path in base.rglob("*"):
                try:
                    st = path.stat()
                except OSError:
                    continue
                entries.append((str(path), st.st_mtime_ns, st.st_size))
    try:
        st = AGENT_PROFILE.stat()
        entries.append((str(AGENT_PROFILE), st.st_mtime_ns, st.st_size))
    except OSError:
        pass
    return tuple(sorted(entries))


def _scan(root: Path) -> dict[str, dict]:
    runs_dir = root / "runs"
    runs = []
    if runs_dir.is_dir():
        for path in sorted(runs_dir.iterdir()):
            if path.is_dir() and RUN_ID.fullmatch(path.name):
                run = _read_run(path)
                if run is not None:
                    runs.append(run)
    episodes = _read_episodes(root / "episodes")
    paired = _pair(runs, episodes)
    controller = _controller()
    out: dict[str, dict] = {}
    for run in sorted(runs, key=lambda r: r["start"], reverse=True):
        episode = paired.get(run["id"])
        out[run["id"]] = {
            "summary": _summary(run, episode["record"] if episode else None, controller),
            "events": run["events"],
            "evidence": run["evidence"],
            "evidence_index": run["index"],
            "episode": episode["record"] if episode else None,
            "sources": {
                "events": _display(run["dir"] / "events.jsonl", root),
                "episode": _display(episode["path"], root) if episode else None,
            },
        }
    return out


def _read_run(path: Path) -> dict | None:
    events = _jsonl(path / "events.jsonl")
    # Sequence order; stable, so events without a sequence keep their place in the file.
    events.sort(key=lambda e: e["sequence"] if isinstance(e.get("sequence"), int) else float("inf"))
    stamped = [(e["timestamp"], t) for e in events if (t := _parse_time(e.get("timestamp"))) is not None]
    if not stamped:
        return None
    evidence = {}
    ev_dir = path / "evidence"
    if ev_dir.is_dir():
        files = [(int(m.group(1)), p) for p in ev_dir.glob("ev-*.json") if (m := EVIDENCE_FILE.fullmatch(p.stem))]
        for _, p in sorted(files):
            content = _json(p)
            if content is not None:
                evidence[p.stem] = content
    index = _jsonl(path / "evidence.jsonl")
    return {
        "id": path.name,
        "dir": path,
        "events": events,
        "index": index,
        "evidence": evidence,
        "start": stamped[0][1],
        "started_at": stamped[0][0],
        "agent_ended_at": stamped[-1][0],
        "environment": _environment(events, index),
    }


def _read_episodes(path: Path) -> list[dict]:
    out = []
    if path.is_dir():
        for p in sorted(path.glob("*.json")):
            record = _json(p)
            if isinstance(record, dict):
                out.append({"path": p, "record": record, "at": _parse_time(record.get("at"))})
    return out


def _pair(runs: list[dict], episodes: list[dict]) -> dict[str, dict]:
    ids = {r["id"] for r in runs}
    paired: dict[str, dict] = {}
    used: set[int] = set()
    for i, ep in enumerate(episodes):
        rid = ep["record"].get("run_id")
        if isinstance(rid, str) and rid in ids and rid not in paired:
            paired[rid] = ep
            used.add(i)
    timed = sorted(
        (i for i, ep in enumerate(episodes) if i not in used and ep["at"] is not None and not ep["record"].get("run_id")),
        key=lambda i: episodes[i]["at"],
    )
    for run in sorted(runs, key=lambda r: r["start"]):
        if run["id"] in paired:
            continue
        for i in timed:
            if i not in used and run["start"] <= episodes[i]["at"] <= run["start"] + PAIR_WINDOW:
                paired[run["id"]] = episodes[i]
                used.add(i)
                break
    return paired


# ------------------------------------------------------------------- summary


def _summary(run: dict, episode: dict | None, controller: str) -> dict:
    events = run["events"]
    ep = episode or {}
    decision = _dict(ep.get("decision"))
    executor = _dict(ep.get("executor"))
    validated = _last_payload(events, "decision_validated")
    plan = _dict(decision.get("repair_plan")) or _dict(validated.get("repair_plan"))
    target = executor.get("service") or _dict(_dict(plan.get("action")).get("arguments")).get("target")
    terminal = next((e for e in reversed(events) if e.get("event_type") in ("run_completed", "run_failed")), None)
    completed = terminal is not None and terminal.get("event_type") == "run_completed"
    failure = None
    if not completed:
        failed = _last_payload(events, "run_failed")
        failure = ": ".join(str(failed[k]) for k in ("error_type", "message") if failed.get(k)) or None
    fault = _str(ep.get("fault"))
    action = ep.get("action")
    return {
        "id": run["id"],
        "fault": fault,
        "title": TITLES.get(fault or "") or fault or "Recorded incident",
        "target": _str(target),
        "solver": _str(ep.get("solver")),
        "controller": controller,
        "environment": run["environment"],
        "serving_image": _str(_dict(executor.get("before")).get("image")),
        "started_at": run["started_at"],
        "agent_ended_at": run["agent_ended_at"],
        "ended_at": _str(ep.get("at")),
        "agent_outcome": "completed" if completed else "failed",
        "failure": failure,
        "terminal_state": _str(ep.get("terminal_state")),
        "success": ep.get("success") if isinstance(ep.get("success"), bool) else None,
        "false_verified": ep.get("false_verified") if isinstance(ep.get("false_verified"), bool) else None,
        "solve_seconds": _number(ep.get("solve_seconds")),
        "tool_calls": sum(e.get("event_type") == "context_requested" for e in events),
        "evidence_count": sum(e.get("event_type") == "evidence_recorded" for e in events),
        "summary": _str(decision.get("summary")) or _str(validated.get("summary")),
        "action": action if isinstance(action, dict) and action else None,
        "remedy": _remedy(fault),
    }


def _remedy(fault: str | None) -> dict | None:
    """How the referee scores this fault: which workers it expects fixed, and which drained
    for a human (a drained link is never "fixed"). From nexus.eval.episode.FAULTS."""
    if not fault:
        return None
    try:
        from nexus.eval.episode import FAULTS
    except Exception:  # noqa: BLE001 - the referee's table is context; a run loads without it
        return None
    spec = FAULTS.get(fault)
    if not isinstance(spec, dict):
        return None
    return {
        "fix": [f"target-{w}" for w in spec.get("fix", [])],
        "drain": [f"target-{w}" for w in spec.get("drain", [])],
        "heldout": bool(spec.get("heldout")),
        "expect_action": bool(spec.get("expect_action", True)),
    }


def _environment(events: list[dict], index: list[dict]) -> str | None:
    sources = [_dict(_dict(e.get("payload")).get("evidence")).get("source") for e in events if e.get("event_type") == "evidence_recorded"]
    sources += [row.get("source") for row in index]
    for source in sources:
        if isinstance(source, str) and source.startswith("environment:") and len(source) > len("environment:"):
            return source.removeprefix("environment:")
    return None


def _controller() -> str:
    try:
        model = json.loads(AGENT_PROFILE.read_text()).get("model")
    except (OSError, ValueError, AttributeError):
        model = None
    return model if isinstance(model, str) and model.strip() else NO_MODEL


# ------------------------------------------------------------------- helpers


def _last_payload(events: list[dict], event_type: str) -> dict:
    for e in reversed(events):
        if e.get("event_type") == event_type:
            return _dict(e.get("payload"))
    return {}


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _str(value) -> str | None:
    return value if isinstance(value, str) and value else None


def _number(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        t = datetime.fromisoformat(value)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _jsonl(path: Path) -> list[dict]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            out.append(item)
    return out


def _display(path: Path, root: Path) -> str:
    """A path for people: relative to the repo when inside it, else to the recordings root's parent."""
    path = path.resolve()
    for base in (REPO, root.resolve().parent):
        try:
            return path.relative_to(base).as_posix()
        except ValueError:
            continue
    return path.name
