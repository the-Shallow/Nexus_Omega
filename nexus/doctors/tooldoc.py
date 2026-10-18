"""Tool-Calling Doctor: silent tool-call failures (incident class: Tool-call correctness).

Follows docs/agentic-requirements.md §10: distinguish six causes, expand context
through read-only tools, repair the parser/template pair together, verify on
canaries the agent never saw.
"""

from __future__ import annotations

from nexus.simulator.model import Twin

from . import tools as T
from .base import DoctorRun, clock, sleep


class ToolCallDoctor(DoctorRun):
    doctor = "tool"
    title = "Tool-Calling Doctor"
    HYPOTHESES = {
        "no_tool_attempt": "Model did not attempt a tool call",
        "malformed_arguments": "Model emitted malformed arguments",
        "parser_template_mismatch": "Parser and chat template disagree on the call envelope",
        "tool_choice_disabled": "Tool choice disabled or misconfigured",
        "client_discard": "Client discarded a correctly parsed response",
        "infrastructure": "Infrastructure failure (process, network, capacity)",
    }

    def flow(self, twin: Twin):
        failing = self.signal["workers"]
        svc = failing[0]
        self.incident = {
            "title": "Silent tool-call failure",
            "incident_class": "Tool-call correctness",
            "candidate_id": "VLLM-32926",
            "upstream_url": "https://github.com/vllm-project/vllm/issues/32926",
            "target": ", ".join(failing),
            "targets": failing,
        }
        self.signature = ["class:tool-call", "http:200", "health:ok", "canary:fail", "tool_calls:empty"]

        # INGEST: the canary is the only alarm.
        self.goto(twin, "INGEST", "functional canary failed while health checks pass")
        ok, canary = self.call(twin, "run_canary", T.run_canary, {}, "Confirm which replicas fail the tool-call probe")
        self.evidence(
            twin, "canary", "tool_call_canary",
            f"{len(canary['failing'])} of {len(canary['results'])} replicas return no tool_calls on the canary",
            data=canary,
        )
        yield sleep(2.0)

        self.goto(twin, "DIAGNOSE", "rank causes from the initial bundle")
        ok, workers = self.call(twin, "list_workers", T.list_workers, {}, "Rule out process and capacity failures", "infrastructure")
        bad = [w for w in workers if w["service"] in failing]
        self.evidence(
            twin, "metrics", "gateway",
            "Failing replicas answer /health 200, serve tokens and have no HTTP errors",
            contradicts=["infrastructure"],
            data=bad,
        )
        self.signature.append("errors:none")
        yield sleep(2.5)

        # Context round 1: what is this replica actually running?
        self.goto(twin, "EXPAND_CONTEXT", "serving config and recent changes")
        ok, cfg = self.call(twin, "read_serving_config", T.read_serving_config, {"service": svc}, "Confirm the active parser and chat template", "parser_template_mismatch")
        self.evidence(
            twin, "serving_config", svc,
            f"Parser {cfg['tool_parser']} with chat template {cfg['chat_template']}; auto tool choice is enabled",
            supports=["parser_template_mismatch"] if cfg["contract"] == "mismatched" else [],
            contradicts=["tool_choice_disabled"],
            data=cfg,
        )
        self.signature += [f"parser:{cfg['tool_parser']}", f"template:{cfg['chat_template']}"]
        yield sleep(1.5)
        ok, history = self.call(twin, "get_change_history", T.get_change_history, {"window_s": 1800}, "Did anything change before the canary failed?", "parser_template_mismatch")
        if history:
            first = history[0]
            self.evidence(
                twin, "change_history", "deploy log",
                f"{first['source']} at {clock(first['t'])} touched {len({h['worker'] for h in history})} replicas",
                supports=["parser_template_mismatch"],
                data=history,
            )
            self.signature.append("config:recent_change")
        yield sleep(2.5)

        # Context round 2: what did the model actually write?
        self.goto(twin, "EXPAND_CONTEXT", "raw generation and parser logs")
        ok, raw = self.call(twin, "read_raw_generation", T.read_raw_generation, {"service": svc, "request_id": "req-canary-0412"}, "Compare the model's raw output with the parsed response", "parser_template_mismatch")
        if not ok:
            yield sleep(1.0)
            ok, raw = self.call(twin, "read_raw_generation", T.read_raw_generation, {"service": svc, "request_id": "latest"}, "Retry with the latest request: the canary trace rotated out")
        if ok:
            shaped = raw["raw_output"].lstrip().startswith(("{", "<tool_call>"))
            self.evidence(
                twin, "raw_generation", raw["request_id"],
                "Model emitted a valid call-shaped JSON payload; the API returned it as text with tool_calls = []",
                supports=["parser_template_mismatch"],
                contradicts=["no_tool_attempt", "malformed_arguments"] if shaped else [],
                data=raw,
            )
            self.signature += ["raw:call_shaped", "contract:parser_template_mismatch"]
        yield sleep(1.5)
        ok, logs = self.call(twin, "read_logs", T.read_logs, {"service": svc, "limit": 6}, "Look for parser warnings", "parser_template_mismatch")
        warn = [line for line in logs["lines"] if "tool_parser" in line]
        self.evidence(
            twin, "logs", svc,
            warn[-1] if warn else "No parser warnings in the window",
            supports=["parser_template_mismatch"] if warn else [],
            contradicts=["client_discard"] if warn else [],
            data=logs,
        )
        yield sleep(2.0)

        # Context round 3: have we seen this before?
        self.goto(twin, "EXPAND_CONTEXT", "incident memory")
        self.diagnosis = {"hypothesis": max(self.hyp, key=self.hyp.get)}
        self.retrieve_context(twin)
        yield sleep(2.0)

        top = self.ranking()[0]
        self.goto(twin, "DIAGNOSE", "leading hypothesis cites evidence")
        self.diagnosis = {
            "hypothesis": top["id"],
            "confidence": top["confidence"],
            "evidence": top["supports"],
            "summary": f"{cfg['tool_parser']} parser expects <tool_call> tags but template {cfg['chat_template']} no longer asks for them, so calls arrive as text",
        }
        self.emit(twin, "decision", self.diagnosis["summary"], self.diagnosis)
        if top["id"] != "parser_template_mismatch" or top["confidence"] < 0.6:
            self.finish(twin, "ABSTAIN", "evidence does not single out a cause")
            return
        yield sleep(2.0)

        self.goto(twin, "PLAN", "bounded repair with rollback")
        self.plan = {
            "hypothesis_id": top["id"],
            "confidence": top["confidence"],
            "evidence": top["supports"],
            "action": {"tool": "patch_serving_config", "arguments": {"services": failing, "approved_profile": "qwen25-coder-tools-v1", "rolling": True}},
            "expected_effect": "Plain JSON calls become structured tool_calls; canary returns to 100%.",
            "risk": "Each replica restarts once; it is drained first so no request is dropped.",
            "verification_plan": ["tool_call_canary", "hidden_canary", "slo"],
            "rollback_plan": "Restore the captured config and restart the same replicas.",
        }
        self.emit(twin, "plan", "Patch the parser and chat template together, one replica at a time", self.plan)
        yield sleep(2.0)

        yield from self.precheck_and_act(
            twin,
            [{"kind": "tool_parser", "targets": failing}],
            rejected={"parser-only": "single-sided repair: parser and template must change together (requirements §10)"},
        )
        if self.done:
            return
        yield from self.verify(twin, timeout_s=60 * len(failing) + 120)

    def checks(self, twin: Twin) -> list[dict]:
        targets = [twin.state.workers[w] for w in self.incident["targets"]]
        back = [w for w in targets if w.state == "ready" and twin.in_rotation(w) and w.canary_ok]
        return super().checks(twin) + [
            {"name": "Repaired replicas back in rotation", "passed": len(back) == len(targets), "detail": f"{len(back)}/{len(targets)} re-admitted after canary"}
        ]
