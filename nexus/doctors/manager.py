"""Detect incidents from twin telemetry and run the right doctor.

Routing rule (from the incident classes): a replica that fails the functional
canary while it is healthy, serving tokens and fast is a tool-call problem;
every other alarm goes to the Infrastructure Doctor.
"""

from __future__ import annotations

from pathlib import Path

from nexus.certificate import CertificateStore
from nexus.simulator.model import Twin

from .base import DoctorRun
from .infradoc import InfrastructureDoctor
from .tooldoc import ToolCallDoctor

DEBOUNCE_S = 3.0


class DoctorManager:
    def __init__(self, store_root: Path, autopilot: bool = True) -> None:
        self.store = CertificateStore(store_root)
        self.autopilot = autopilot
        self.enabled = True
        self.runs: list[DoctorRun] = []
        self._pending: dict | None = None
        self._suppressed: set[str] = set()

    @property
    def active(self) -> DoctorRun | None:
        return next((r for r in reversed(self.runs) if not r.done), None)

    def reset(self) -> None:
        self.runs, self._pending, self._suppressed = [], None, set()

    def signals(self, twin: Twin) -> dict | None:
        s = twin.state
        if not s.series:
            return None
        k = s.series[-1]
        slo = twin.profile["slo"]
        tool_suspects = []
        for w in s.workers.values():
            if not twin.in_rotation(w) or w.state != "ready" or not w.healthy or w.canary_ok:
                continue
            wk = twin.worker_kpis(w)
            if wk["tps_now"] > 0 and (wk["ttft_p95"] or 0) < 0.6:
                tool_suspects.append(w.id)
        alarms = []
        if k["ttft_p95"] is None or k["ttft_p95"] > slo["ttft_p95_s"]:
            alarms.append("TTFT SLO breach")
        if k["tpot_p95"] is not None and k["tpot_p95"] > slo["tpot_p95_s"]:
            alarms.append("TPOT SLO breach")
        if k["error_rate"] > slo["error_rate"]:
            alarms.append("error-rate SLO breach")
        stalled = [w.id for w in s.workers.values() if twin.in_rotation(w) and not w.canary_ok and w.id not in tool_suspects]
        if stalled:
            alarms.append(f"canary failing on {', '.join(stalled)}")
        if k["supply_c"] > 27:
            alarms.append("supply air above 27 °C")
        if not all(s.ups.values()):
            alarms.append("UPS feed lost")
        if any(g.xid for g in s.gpus if not s.nodes[g.node].cordoned):
            alarms.append("GPU XID reported")
        if any(not c.running for c in s.crahs):
            alarms.append("CRAH alarm")
        open_faults = [f for f in s.faults.values() if f.get("resolved_at") is None]
        fault_t = min((f["t"] for f in open_faults), default=None)  # ground truth, used only to measure time to detect
        if alarms:
            return {"doctor": "infra", "alarms": alarms, "fault_t": fault_t, "key": "infra:" + "|".join(sorted(alarms))}
        if tool_suspects:
            return {"doctor": "tool", "workers": sorted(tool_suspects), "alarms": ["functional failure, health OK"], "fault_t": fault_t, "key": "tool:" + ",".join(sorted(tool_suspects))}
        return None

    def tick(self, twin: Twin) -> DoctorRun | None:
        """Advance the active run, or start one when a signal persists. Returns a newly started run."""
        run = self.active
        if run is not None:
            run.tick(twin)
            if run.done and run.terminal in ("REQUIRES_APPROVAL", "ABSTAIN"):
                self._suppressed.add(run.signal["key"].split(":")[0])
            return None
        if not self.enabled:
            return None
        signal = self.signals(twin)
        if signal is None:
            self._pending, self._suppressed = None, set()
            return None
        if signal["key"].split(":")[0] in self._suppressed:
            return None
        if self._pending is None or self._pending["key"] != signal["key"]:
            self._pending = {**signal, "since": twin.now}
            return None
        if twin.now - self._pending["since"] < DEBOUNCE_S:
            return None
        self._pending = None
        cls = ToolCallDoctor if signal["doctor"] == "tool" else InfrastructureDoctor
        run = cls(twin, signal, self.store, autopilot=self.autopilot)
        self.runs.append(run)
        twin.log("action", f"{run.title} engaged · {', '.join(signal['alarms'])}", None, "doctor")
        run.tick(twin)
        return run
