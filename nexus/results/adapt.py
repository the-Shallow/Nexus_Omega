"""Turn a real agent run (events.jsonl + its episode record) into the UI's run shapes.

The React panels were built around the twin's DoctorSnapshot / RunEvent / ToolCallRecord
(apps/web/src/lib/types.ts). Mapping the real trail onto the same shapes lets the
ToolCalls, Incident and Recovery panels show a Nemotron run unchanged.

The agent's own run ends at PRECHECK when it hands a repair to the executor; the
referee's verdict lives in the episode record. When the episode is known, its
executor action and verification are appended so the snapshot ends where the
episode did. Without it, the snapshot ends wherever the trail ends.
"""
from __future__ import annotations

from datetime import datetime

TERMINAL = {"VERIFIED", "ROLLED_BACK", "REQUIRES_APPROVAL", "ABSTAIN"}
TOOL_FAULTS = {"vllm-32926", "tools-stripped-a", "compound-latb-32926a"}
TOOL_CLASS = {"run_probe": "test", "apply_action": "mutate"}


def _ts(value: str | None) -> float | None:
    try:
        return datetime.fromisoformat(value).timestamp() if value else None
    except ValueError:
        return None


def _clock(value: str | None) -> str:
    return value[11:19] if value and len(value) >= 19 else ""


class RunAdapter:
    """Feed envelopes in sequence order; read back RunEvents and a DoctorSnapshot."""

    def __init__(self, run_id: str, episode: dict | None = None) -> None:
        self.run_id = run_id
        self.episode = episode
        self.t0: float | None = None
        self.state = "INGEST"
        self.states: list[dict] = []
        self.events: list[dict] = []
        self.calls: dict[str, dict] = {}
        self.ledger: list[dict] = []
        self.hypotheses: list[dict] = []
        self.summary = ""
        self.trigger: dict = {}
        self.limits: dict = {}
        self.usage = {"steps": 0, "context_rounds": 0, "tool_calls": 0, "mutations": 0}
        self.chosen: str | None = None
        self.terminal: str | None = None
        self.terminal_reason = ""
        self.last_seq = 0

    # ---- feeding --------------------------------------------------------------------------
    def feed(self, envelope: dict) -> list[dict]:
        """Consume one envelope; return the RunEvents it produced (possibly none)."""
        self.last_seq = envelope.get("sequence", self.last_seq)
        stamp = envelope.get("timestamp")
        if self.t0 is None:
            self.t0 = _ts(stamp) or 0.0
        t = round((_ts(stamp) or self.t0) - self.t0, 2)
        clock = _clock(stamp)
        kind, p = envelope.get("event_type"), envelope.get("payload") or {}
        out: list[dict] = []

        def emit(k: str, title: str, detail: dict | None = None) -> None:
            ev = {"seq": len(self.events) + 1, "t": t, "clock": clock, "state": self.state,
                  "kind": k, "title": title, "detail": detail or {}}
            self.events.append(ev)
            out.append(ev)

        if kind == "run_started":
            self.trigger = p.get("trigger") or {}
            self.limits = p.get("limits") or {}
            self.state = p.get("state", "DIAGNOSE")
            self.states.append({"state": self.state, "t": t, "clock": clock})
            emit("state", "Run started", {"trigger": self.trigger.get("summary")})
        elif kind == "state_transition":
            self.state = p.get("to", self.state)
            self.states.append({"state": self.state, "t": t, "clock": clock})
            emit("state", f"{p.get('from')} → {p.get('to')}")
        elif kind == "context_requested":
            record = {"call_id": p.get("call_id"), "tool": p.get("tool"),
                      "class": TOOL_CLASS.get(p.get("tool"), "read"),
                      "arguments": p.get("operational_arguments") or {}, "reason": p.get("reason", ""),
                      "hypothesis": p.get("hypothesis_id"), "t": t, "status": "ok", "result": None}
            self.calls[record["call_id"]] = record
            self.usage["tool_calls"] += 1
            emit("tool_call", p.get("tool", "tool call"), record)
        elif kind == "tool_call_rejected":
            record = self.calls.get(p.get("call_id"))
            if record is None:
                record = {"call_id": p.get("call_id"), "tool": p.get("tool"), "class": "read", "arguments": {},
                          "reason": "", "hypothesis": None, "t": t, "status": "error"}
                emit("tool_call", p.get("tool", "tool call"), record)
            record.update(status="error", error_code="rejected", error=p.get("error", ""))
        elif kind == "evidence_recorded":
            ev = p.get("evidence") or {}
            row = {k: ev.get(k) for k in ("evidence_id", "finding", "source_type", "source", "collected_at")}
            self.ledger.append(row)
            record = self.calls.get(p.get("call_id"))
            if record is not None:
                record["result"] = {"evidence_id": ev.get("evidence_id"), "finding": ev.get("finding"),
                                    "source": ev.get("source")}
            emit("evidence", ev.get("finding") or ev.get("evidence_id", "evidence"), row)
        elif kind == "model_turn_validated":
            names = [c.get("name") for c in p.get("tool_calls") or []]
            emit("note", f"Model turn: {', '.join(names)}" if names else "Model turn (no tool calls)", p)
        elif kind == "context_budget_reached":
            emit("note", "Context budget reached", p)
        elif kind == "repair_tool_call_redirected":
            emit("note", "Repair call redirected into the plan", p)
        elif kind in ("decision_reformat_requested", "decision_reformatted"):
            emit("note", "Decision reformat requested" if kind.endswith("requested") else "Decision reformatted", p)
        elif kind == "decision_validated":
            self.summary = p.get("summary", "")
            hyps = sorted(p.get("hypotheses") or [], key=lambda h: -h.get("confidence", 0))
            self.hypotheses = [{"id": h.get("id"), "label": self.summary.split(". ")[0] if i == 0 else h.get("id"),
                                "confidence": h.get("confidence", 0), "supports": h.get("supports", []),
                                "contradicts": h.get("contradicts", [])} for i, h in enumerate(hyps)]
            if p.get("state") in TERMINAL:
                self.terminal, self.terminal_reason = p["state"], p.get("stop_reason", "")
            emit("decision", self.summary or p.get("stop_reason", "decision"), p)
        elif kind == "repair_plan_evaluated":
            approval, policy = p.get("approval") or {}, p.get("policy") or {}
            self.chosen = " ".join(str(x) for x in (approval.get("action_id"), approval.get("target"),
                                                    (approval.get("parameters") or {}).get("profile")) if x)
            emit("plan", self.chosen or "Repair plan", p.get("repair_plan") or {})
            emit("policy", f"Policy {policy.get('status', '?')}: {policy.get('reason', '')}",
                 {"policy": "declared-actions", "decision": policy.get("status"), "reason": policy.get("reason")})
        elif kind == "before_state_captured":
            emit("precheck", "Before state captured", p)
        elif kind in ("run_completed", "run_failed"):
            for key in ("steps", "context_rounds", "tool_calls"):
                if key in p:
                    self.usage[key] = p[key]
            if kind == "run_failed":
                self.terminal = "ABSTAIN"
                self.terminal_reason = f"{p.get('error_type')}: {p.get('message')}"
            elif p.get("state") in TERMINAL:
                self.terminal = p["state"]
            emit("terminal" if self.terminal else "note",
                 f"Run {'failed' if kind == 'run_failed' else 'completed'} at {p.get('state', self.state)}", p)
        return out

    def finish(self) -> list[dict]:
        """Append the referee's view from the episode record, once the trail is done."""
        e = self.episode
        if not e:
            return []
        out = []
        stamp = (e.get("executor") or {}).get("ended_at") or e.get("at")
        t = round((_ts(stamp) or self.t0 or 0) - (self.t0 or 0), 2)

        def emit(k: str, title: str, detail: dict) -> None:
            ev = {"seq": len(self.events) + 1, "t": t, "clock": _clock(stamp), "state": self.state,
                  "kind": k, "title": title, "detail": detail}
            self.events.append(ev)
            out.append(ev)

        executor = e.get("executor")
        if executor:
            self.usage["mutations"] += 1
            emit("action", f"{executor.get('action')} {executor.get('service')} → {executor.get('status')}",
                 {"kind": executor.get("action"), "token": executor.get("change_id"), "executor": executor})
        v = e.get("verification") or {}
        checks = [{"name": name, "passed": bool(v.get(key)), "detail": ""} for name, key in
                  (("users served", "users_ok"), ("hidden canary", "hidden_passed"),
                   ("root cause fixed", "root_fixed"), ("faulty worker drained", "faulty_worker_drained"))
                  if key in v]
        if checks:
            emit("verify", "Independent referee", {"checks": checks, "verification": v})
        self.state = self.terminal = e.get("terminal_state") or self.terminal
        self.terminal_reason = ("success" if e.get("success") else "failed") + \
            (", false VERIFIED" if e.get("false_verified") else "") + f" (referee, {e.get('solve_seconds')} s)"
        emit("terminal", f"Episode {self.terminal}", {"success": e.get("success"),
                                                      "false_verified": e.get("false_verified")})
        return out

    # ---- reading --------------------------------------------------------------------------
    def snapshot(self) -> dict:
        fault = (self.episode or {}).get("fault")
        targets = self.trigger.get("affected_resources", [])
        return {
            "id": self.run_id, "doctor": "tool" if fault in TOOL_FAULTS or not fault else "infra",
            "title": fault or self.trigger.get("trigger_id", self.run_id), "controller": "nemotron",
            "state": self.terminal or self.state, "states": self.states,
            "terminal": self.terminal, "terminal_reason": self.terminal_reason,
            "incident": {"title": fault or self.trigger.get("summary", ""), "incident_class": "live",
                         "candidate_id": fault, "targets": targets},
            "signal": {"doctor": "nemotron", "alarms": [], "fault_t": None},
            "events": self.events, "hypotheses": self.hypotheses, "ledger": self.ledger, "usage": self.usage,
            "budget": {"max_steps": self.limits.get("max_steps", 0),
                       "max_context_rounds": self.limits.get("max_context_rounds", 0),
                       "max_tool_calls": self.limits.get("max_tool_calls", 0), "max_mutations": 1},
            "matches": [], "precheck": None, "chosen": self.chosen, "awaiting_approval": False,
            "autopilot": True, "certificate_id": None, "episode_id": (self.episode or {}).get("id"),
        }


def snapshot(run_id: str, events: list[dict], episode: dict | None = None) -> dict:
    adapter = RunAdapter(run_id, episode)
    for envelope in events:
        adapter.feed(envelope)
    if any(e.get("event_type") in ("run_completed", "run_failed") for e in events):
        adapter.finish()
    return adapter.snapshot()
