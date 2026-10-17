"""Shared doctor runtime: state machine, evidence ledger, hypotheses, budgets, certificate.

Both doctors run this same loop (INGEST → DIAGNOSE → EXPAND_CONTEXT → PLAN →
PRECHECK → ACT → VERIFY → terminal) and differ only in their tools and rules.

The reasoning in this module is a deterministic, rule-based stand-in for
Nemotron so the twin and UI can be exercised before the agent is connected.
Every run says so in ``controller``. Tool calls, actions and verification act on
the twin for real.
"""

from __future__ import annotations

import itertools
from typing import Any, Callable, Iterator

from nexus.simulator import actions
from nexus.simulator.model import Twin

from .tools import TOOL_CLASSES, ToolError

CLOCK_BASE_S = 1 * 3600 + 47 * 60  # twin t=0 is shown as 01:47:00 for the "2 AM" story
STATES = ["INGEST", "DIAGNOSE", "EXPAND_CONTEXT", "PLAN", "PRECHECK", "ACT", "VERIFY"]
TERMINAL = ["VERIFIED", "ROLLED_BACK", "REQUIRES_APPROVAL", "ABSTAIN"]
CONTROLLER = "rule-based stand-in (Nemotron not connected)"
BUDGET = {"max_steps": 12, "max_context_rounds": 5, "max_tool_calls": 20, "max_mutations": 1}
_ids = itertools.count(1)


def clock(t: float) -> str:
    s = int(CLOCK_BASE_S + t) % 86400
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}"


# Instructions a flow can yield.
def sleep(seconds: float) -> tuple:
    return ("sleep", seconds)


def preview(incidents: list[dict]) -> tuple:
    return ("preview", incidents)


def approval() -> tuple:
    return ("approval",)


class DoctorRun:
    doctor = ""
    title = ""
    HYPOTHESES: dict[str, str] = {}
    PRIORS: dict[str, float] = {}

    def __init__(self, twin: Twin, signal: dict, store, autopilot: bool = True) -> None:
        self.id = f"run-{next(_ids):03d}"
        self.signal = signal
        self.store = store
        self.autopilot = autopilot
        self.started_t = twin.now
        self.state = "INGEST"
        self.states: list[dict] = []
        self.events: list[dict] = []
        self.ledger: list[dict] = []
        self.tool_calls: list[dict] = []
        self.policy: list[dict] = []
        self.hyp = {h: self.PRIORS.get(h, 1.0) for h in self.HYPOTHESES}
        self._normalize()
        self.hyp_history: list[dict] = []
        self.usage = {"steps": 0, "context_rounds": 0, "tool_calls": 0, "mutations": 0}
        self.diagnosis: dict | None = None
        self.incident: dict = {}
        self.signature: list[str] = []
        self.matches: list[dict] = []
        self.plan: dict | None = None
        self.precheck: dict | None = None
        self.chosen: dict | None = None
        self.changes: list[dict] = []
        self.verification: dict | None = None
        self.before_kpi = dict(twin.state.series[-1]) if twin.state.series else twin.kpis()
        self.acted_t: float | None = None
        self.closed_t: float | None = None
        self.terminal: str | None = None
        self.terminal_reason = ""
        self.certificate: dict | None = None
        self.preview_request: list[dict] | None = None
        self.preview_result: dict | None = None
        self.approval_choice: str | None = None
        self.awaiting_approval = False
        self._wait: tuple | None = None
        self._gen: Iterator = self.flow(twin)

    # ----------------------------------------------------------------- driver

    @property
    def done(self) -> bool:
        return self.terminal is not None

    def tick(self, twin: Twin) -> None:
        while not self.done:
            value: Any = None
            w = self._wait
            if w is not None:
                if w[0] == "sleep":
                    if twin.now < w[1]:
                        return
                elif w[0] == "preview":
                    if self.preview_result is None:
                        return
                    value, self.preview_request = self.preview_result, None
                elif w[0] == "approval":
                    if self.approval_choice is None:
                        return
                    value, self.awaiting_approval = self.approval_choice, False
            try:
                instr = self._gen.send(value)
            except StopIteration:
                if not self.done:
                    self.finish(twin, "ABSTAIN", "flow ended without a terminal decision")
                return
            if instr[0] == "sleep":
                self._wait = ("sleep", twin.now + instr[1])
            elif instr[0] == "preview":
                self.preview_result, self.preview_request = None, instr[1]
                self._wait = instr
            elif instr[0] == "approval":
                self.approval_choice, self.awaiting_approval = None, True
                self._wait = instr

    def flow(self, twin: Twin) -> Iterator:  # overridden by each doctor
        raise NotImplementedError
        yield

    # ------------------------------------------------------------- recording

    def emit(self, twin: Twin, kind: str, title: str, detail: dict | None = None) -> dict:
        event = {
            "seq": len(self.events) + 1,
            "t": round(twin.now, 1),
            "clock": clock(twin.now),
            "state": self.state,
            "kind": kind,
            "title": title,
            "detail": detail or {},
        }
        self.events.append(event)
        return event

    def goto(self, twin: Twin, state: str, note: str = "") -> None:
        self.state = state
        self.usage["steps"] += 1
        if state == "EXPAND_CONTEXT":
            self.usage["context_rounds"] += 1
        self.states.append({"state": state, "t": round(twin.now, 1), "clock": clock(twin.now)})
        self.emit(twin, "state", state, {"note": note})

    def call(self, twin: Twin, tool: str, fn: Callable, args: dict, reason: str, hypothesis: str | None = None):
        """Invoke a read/test tool through the controller. Returns (ok, result)."""
        if self.usage["tool_calls"] >= BUDGET["max_tool_calls"]:
            self.emit(twin, "policy", f"rejected {tool}: tool-call budget exhausted", {"decision": "rejected"})
            return False, None
        self.usage["tool_calls"] += 1
        record = {
            "call_id": f"call-{len(self.tool_calls) + 1:02d}",
            "tool": tool,
            "class": TOOL_CLASSES.get(tool, "read"),
            "arguments": args,
            "reason": reason,
            "hypothesis": hypothesis,
            "t": round(twin.now, 1),
        }
        try:
            result = fn(twin, **args)
            record.update(status="ok", result=result)
        except ToolError as exc:
            record.update(status="error", error_code=exc.code, error=str(exc))
            result = None
        self.tool_calls.append(record)
        self.emit(twin, "tool_call", tool, record)
        return record["status"] == "ok", result

    def evidence(self, twin: Twin, source_type: str, source: str, finding: str, supports=(), contradicts=(), data=None) -> str:
        ev_id = f"ev-{len(self.ledger) + 1:03d}"
        item = {
            "evidence_id": ev_id,
            "source_type": source_type,
            "source": source,
            "collected_at": clock(twin.now),
            "t": round(twin.now, 1),
            "finding": finding,
            "supports": list(supports),
            "contradicts": list(contradicts),
            "data": data,
        }
        self.ledger.append(item)
        for h in supports:
            self.hyp[h] = self.hyp.get(h, 0.05) * 2.6
        for h in contradicts:
            self.hyp[h] = self.hyp.get(h, 0.05) * 0.3
        self._normalize()
        self.hyp_history.append({"t": round(twin.now, 1), "after": ev_id, "ranking": self.ranking()})
        self.emit(twin, "evidence", finding, item)
        return ev_id

    def _normalize(self) -> None:
        total = sum(self.hyp.values()) or 1.0
        self.hyp = {k: v / total for k, v in self.hyp.items()}

    def ranking(self) -> list[dict]:
        out = []
        for h, p in sorted(self.hyp.items(), key=lambda kv: -kv[1]):
            out.append(
                {
                    "id": h,
                    "label": self.HYPOTHESES.get(h, h),
                    "confidence": round(p, 3),
                    "supports": [e["evidence_id"] for e in self.ledger if h in e["supports"]],
                    "contradicts": [e["evidence_id"] for e in self.ledger if h in e["contradicts"]],
                }
            )
        return out

    def decide(self, twin: Twin, policy: str, decision: str, reason: str) -> None:
        item = {"policy": policy, "decision": decision, "reason": reason, "t": round(twin.now, 1)}
        self.policy.append(item)
        self.emit(twin, "policy", f"{decision}: {policy}", item)

    # ------------------------------------------------- shared later states

    def retrieve_context(self, twin: Twin) -> None:
        def retrieve_incident_context(_twin, signature):
            return self.store.match(signature)

        ok, hits = self.call(
            twin, "retrieve_incident_context", retrieve_incident_context, {"signature": self.signature}, "Look for a past certificate with the same signature"
        )
        self.matches = hits or []
        if self.matches:
            top = self.matches[0]
            self.evidence(
                twin,
                "certificate",
                top["certificate_id"],
                f"Past incident matches {top['similarity']:.0%}: {top['incident']} → {top['repair']} ({top['terminal_state']})",
                supports=[self.diagnosis["hypothesis"]] if self.diagnosis else [],
                data=top,
            )
        else:
            self.emit(twin, "note", "No past certificate matches this signature")

    def precheck_and_act(self, twin: Twin, incidents: list[dict], rejected: dict[str, str] | None = None):
        """PRECHECK in the twin, apply the chosen candidate (generator; use ``yield from``)."""
        self.goto(twin, "PRECHECK", "fork the twin and compare candidates")
        result = yield preview(incidents)
        rejected = rejected or {}
        for c in result["candidates"]:
            c["policy"] = "rejected" if c["id"] in rejected else "allowed"
            c["policy_reason"] = rejected.get(c["id"], "")
        allowed = [c for c in result["candidates"] if c["policy"] == "allowed" and c["actions"]]
        self.precheck = {k: result[k] for k in ("t0", "horizon", "seeds", "calibration")}
        self.precheck["candidates"] = result["candidates"]
        self.emit(twin, "precheck", f"Simulated {len(result['candidates'])} candidates × {len(result['seeds'])} seeds", {"candidates": result["candidates"]})
        for cid, why in rejected.items():
            if any(c["id"] == cid for c in result["candidates"]):
                self.decide(twin, cid, "rejected", why)
        if not allowed:
            self.finish(twin, "ABSTAIN", "no candidate within policy improves the service")
            return
        best = allowed[0]
        self.precheck["recommended"] = best["id"]
        if not self.autopilot:
            self.emit(twin, "approval", f"Awaiting authorization for: {best['label']}", {"recommended": best["id"]})
            choice = yield approval()
            if choice == "reject":
                self.finish(twin, "REQUIRES_APPROVAL", "operator declined the proposed repair")
                return
            best = next((c for c in allowed if c["id"] == choice), best)
            self.decide(twin, best["id"], "approved", "authorized by operator")
        else:
            self.decide(twin, best["id"], "approved", "within automatic policy (autopilot)")
        self.chosen = best
        self.goto(twin, "ACT", best["label"])
        self.usage["mutations"] += 1
        for a in best["actions"]:
            change = actions.apply_action(twin, a["kind"], a.get("args", {}))
            self.changes.append(change)
            self.emit(twin, "action", f"{a['kind']}({', '.join(f'{k}={v}' for k, v in a.get('args', {}).items())})", change)
        self.acted_t = twin.now

    def verify(self, twin: Twin, facility_open: Callable[[Twin], str | None] | None = None, timeout_s: float = 240.0):
        """VERIFY until every check holds for 10 s, else roll back (generator)."""
        self.goto(twin, "VERIFY", "independent checks; the model does not judge its own repair")
        deadline, streak = twin.now + timeout_s, 0
        while True:
            checks = self.checks(twin)
            streak = streak + 1 if all(c["passed"] for c in checks) else 0
            if streak >= 10 or twin.now >= deadline:
                break
            yield sleep(1.0)
        self.verification = {"checks": checks, "after": dict(twin.state.series[-1]), "before": self.before_kpi}
        self.emit(twin, "verify", f"{sum(c['passed'] for c in checks)}/{len(checks)} checks passed", self.verification)
        if streak >= 10:
            open_issue = facility_open(twin) if facility_open else None
            if open_issue:
                self.finish(twin, "REQUIRES_APPROVAL", f"service verified; {open_issue} needs a human")
            else:
                self.finish(twin, "VERIFIED", "all independent checks passed for 10 s")
            return
        reversible = [c for c in self.changes if c["reversible"] and not c.get("rolled_back")]
        for c in reversible:
            actions.rollback(twin, c["token"])
            self.emit(twin, "action", f"rollback {c['token']}", c)
        if reversible:
            self.finish(twin, "ROLLED_BACK", "verification failed; reversible changes restored")
        else:
            self.finish(twin, "REQUIRES_APPROVAL", "verification failed and the change cannot be rolled back")

    def checks(self, twin: Twin) -> list[dict]:
        k = twin.state.series[-1]
        slo = twin.profile["slo"]
        hidden = twin.hidden_canary()
        rotation = [w for w in twin.state.workers.values() if twin.in_rotation(w)]
        canary_cases = 4 * len(rotation)
        canary_pass = round(k["canary"] * canary_cases)
        out = [
            {"name": "Functional tool-call canary", "passed": k["canary"] >= 0.999, "detail": f"{canary_pass}/{canary_cases} cases"},
            {"name": "Hidden canary set", "passed": hidden["passed"] == hidden["total"] > 0, "detail": f"{hidden['passed']}/{hidden['total']} held-out cases"},
            {"name": f"TTFT p95 ≤ {slo['ttft_p95_s']} s", "passed": k["ttft_p95"] is not None and k["ttft_p95"] <= slo["ttft_p95_s"], "detail": f"{k['ttft_p95']:.2f} s" if k["ttft_p95"] else "–"},
            {"name": f"TPOT p95 ≤ {slo['tpot_p95_s'] * 1000:.0f} ms", "passed": k["tpot_p95"] is not None and k["tpot_p95"] <= slo["tpot_p95_s"], "detail": f"{k['tpot_p95'] * 1000:.1f} ms" if k["tpot_p95"] else "–"},
            {"name": f"Error rate ≤ {slo['error_rate']:.0%}", "passed": k["error_rate"] <= slo["error_rate"], "detail": f"{k['error_rate']:.2%}"},
            {"name": "Mutations within policy", "passed": self.usage["mutations"] <= BUDGET["max_mutations"], "detail": f"{len(self.changes)} allow-listed actions, 1 change set"},
        ]
        return out

    # ------------------------------------------------------------ terminal

    def finish(self, twin: Twin, terminal: str, reason: str) -> None:
        self.state = terminal
        self.terminal, self.terminal_reason = terminal, reason
        self.closed_t = twin.now
        self.states.append({"state": terminal, "t": round(twin.now, 1), "clock": clock(twin.now)})
        self.emit(twin, "terminal", terminal, {"reason": reason})
        self.certificate = self.store.save(self.build_certificate(twin))
        self.emit(twin, "certificate", f"Certificate {self.certificate['certificate_id']} issued", {"certificate_id": self.certificate["certificate_id"]})

    def build_certificate(self, twin: Twin) -> dict:
        fault_t = self.signal.get("fault_t")
        window = [x for x in twin.state.series if x["t"] >= (fault_t or self.started_t)]
        slo = twin.profile["slo"]
        dashboards = any(
            (x["ttft_p95"] or 0) > slo["ttft_p95_s"] or x["error_rate"] > slo["error_rate"] for x in window
        )
        reversible = [c for c in self.changes if c["reversible"]]
        cert = {
            "certificate_id": f"cert-{clock(self.closed_t).replace(':', '')}-{self.id}",
            "doctor": self.doctor,
            "provenance": "twin",
            "controller": CONTROLLER,
            "issued_at": f"{clock(self.closed_t)} (twin T+{self.closed_t:.0f}s)",
            "run_id": self.id,
            "incident": self.incident,
            "signature": self.signature,
            "diagnosis": self.diagnosis or {"summary": "not diagnosed", "hypothesis": None},
            "timeline": {
                "fault_t": fault_t,
                "fault_clock": clock(fault_t) if fault_t is not None else None,
                "detected_t": round(self.started_t, 1),
                "detected_clock": clock(self.started_t),
                "acted_clock": clock(self.acted_t) if self.acted_t is not None else None,
                "closed_clock": clock(self.closed_t),
                "time_to_detect_s": round(self.started_t - fault_t, 1) if fault_t is not None else None,
                "time_to_recover_s": round(self.closed_t - (fault_t if fault_t is not None else self.started_t), 1),
            },
            "states": self.states,
            "tool_calls": self.tool_calls,
            "evidence": self.ledger,
            "hypotheses": self.ranking(),
            "hypothesis_history": self.hyp_history,
            "policy": self.policy,
            "matched_certificates": self.matches,
            "plan": self.plan,
            "precheck": self._precheck_summary(),
            "repair": {
                "label": self.chosen["label"] if self.chosen else None,
                "actions": self.chosen["actions"] if self.chosen else [],
                "change_tokens": [c["token"] for c in self.changes],
                "rollback_token": reversible[0]["token"] if reversible else None,
                "rollback_exercised": any(c.get("rolled_back") for c in self.changes),
                "before_state": [c["before"] for c in self.changes],
            },
            "verification": self.verification,
            "prediction_vs_actual": self._prediction_vs_actual(twin),
            "dashboards_alerted": dashboards,
            "budget": {"limits": BUDGET, "used": self.usage},
            "terminal_state": self.terminal,
            "terminal_reason": self.terminal_reason,
        }
        return cert

    def _precheck_summary(self) -> dict | None:
        if not self.precheck:
            return None
        return {
            **{k: v for k, v in self.precheck.items() if k != "candidates"},
            "candidates": [
                {k: c.get(k) for k in ("id", "label", "slo_fraction", "final_slo_ok", "final_capacity", "recovered_s", "mean_error", "peak_ttft_p95", "policy", "policy_reason")}
                for c in self.precheck["candidates"]
            ],
        }

    def _prediction_vs_actual(self, twin: Twin) -> dict | None:
        if not (self.chosen and self.precheck and self.acted_t is not None):
            return None
        series = self.chosen["series"]
        t0 = self.precheck["t0"]
        pairs = []
        for actual in twin.state.series:
            if actual["t"] < self.acted_t or actual["ttft_p95"] is None:
                continue
            rel = actual["t"] - t0
            if rel > series["t"][-1]:
                break
            i = min(range(len(series["t"])), key=lambda j: abs(series["t"][j] - rel))
            pred = series["ttft_p95"]["mid"][i]
            if pred is not None:
                pairs.append((rel, pred, actual["ttft_p95"]))
        if not pairs:
            return None
        mae = sum(abs(p - a) for _, p, a in pairs) / len(pairs)
        return {"metric": "ttft_p95", "samples": len(pairs), "mae_s": round(mae, 3), "points": [[round(t, 1), round(p, 3), round(a, 3)] for t, p, a in pairs[::3]]}

    # --------------------------------------------------------------- export

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "doctor": self.doctor,
            "title": self.title,
            "controller": CONTROLLER,
            "state": self.state,
            "states": self.states,
            "terminal": self.terminal,
            "terminal_reason": self.terminal_reason,
            "incident": self.incident,
            "signal": self.signal,
            "events": self.events,
            "hypotheses": self.ranking(),
            "ledger": self.ledger,
            "usage": self.usage,
            "budget": BUDGET,
            "matches": self.matches,
            "plan": self.plan,
            "precheck": self.precheck,
            "chosen": self.chosen["id"] if self.chosen else None,
            "awaiting_approval": self.awaiting_approval,
            "autopilot": self.autopilot,
            "certificate_id": self.certificate["certificate_id"] if self.certificate else None,
        }
