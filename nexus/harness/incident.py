"""Incident start marker: keeps one episode's evidence from leaking into the next.

Episodes run back to back on the same fleet, and Prometheus windows and
docker logs reach back across them. In Batch 2 the agent asked for a 10m
window during the compound fault and saw b's TTFT of 4.8 s and queue of 4,
left over from the previous episode's capacity fault. The episode runner marks
the start after each reset; the environment API then clamps metric windows
and log 'since' so the agent sees only the current incident.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from nexus.harness.inspect import SINCE_RE, docker_since

ROOT = Path(__file__).resolve().parents[2]
# Kept out of runtime/state/*.json, which the manager reads as worker state.
MARK = ROOT / "runtime" / "state" / "faults" / "incident-start"
MIN_WINDOW_S = 15  # three Prometheus scrapes at 5 s


def mark_start() -> None:
    MARK.parent.mkdir(parents=True, exist_ok=True)
    MARK.write_text(f"{time.time():.3f}\n")


def age_s() -> float | None:
    try:
        return max(0.0, time.time() - float(MARK.read_text()))
    except (OSError, ValueError):
        return None


def seconds(window: str) -> int:
    match = SINCE_RE.match(window)
    return int(match.group(1)) * {"s": 1, "m": 60, "h": 3600}[match.group(2)]


def clamp_window(window: str) -> tuple[str, bool]:
    """A Prometheus range that starts no earlier than the incident; returns (range, clamped)."""
    age = age_s()
    requested = seconds(window)
    if age is None or requested <= age:
        return window, False
    return f"{max(MIN_WINDOW_S, int(age))}s", True


def clamp_since(since: str) -> tuple[str, bool]:
    """A docker logs 'since' no earlier than the incident; returns (since, clamped)."""
    since = docker_since(since)
    age = age_s()
    if age is None:
        return since, False
    now = datetime.now(timezone.utc)
    start = now - timedelta(seconds=age)
    asked = now - timedelta(seconds=seconds(since)) if SINCE_RE.match(since) else \
        datetime.fromisoformat(since.replace("Z", "+00:00"))
    if asked >= start:
        return since, False
    return start.isoformat(timespec="seconds").replace("+00:00", "Z"), True
