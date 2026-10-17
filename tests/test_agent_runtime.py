import json
import tempfile
import unittest
from pathlib import Path

from nexus.agent.budgets import BudgetExceeded
from nexus.agent.client import ScriptedNemotronClient
from nexus.agent.runtime import AgentController
from nexus.agent.diagnostic_tools import DiagnosticToolRegistry
from nexus.agent.contracts import ContractError, ModelTurn, ToolCall
from nexus.agent.events import JsonlEventLog
from nexus.agent.evidence import EvidenceLedger
from nexus.agent.policy import (
    ApprovedServingProfile,
    RepairPolicy,
    RepairPrecheck,
)
from nexus.agent.repository import BoundedRepository


class FakeDiagnosticBackend:
    def __init__(self) -> None:
        self.canary_runs = 0

    def get_status(self):
        return {"healthy": True, "services": ["target-a"]}

    def run_canary(self, case):
        self.canary_runs += 1
        return {
            "case": case,
            "request_id": "req-184",
            "http_status": 200,
            "parsed_tool_call_count": 0,
        }

    def get_launch_config(self, service):
        return {
            "service": service,
            "enable_auto_tool_choice": True,
            "tool_call_parser": "hermes",
            "chat_template": "default",
        }

    def get_request_trace(self, request_id):
        return {
            "request_id": request_id,
            "http_status": 200,
            "structured_response": {"tool_calls": []},
        }

    def read_raw_generation(self, request_id):
        return {
            "request_id": request_id,
            "text": "```json\n{\"name\":\"get_weather\",\"arguments\":{}}\n```",
        }

    def read_logs(self, service, since, pattern, limit):
        return {
            "service": service,
            "since": since,
            "pattern": pattern,
            "limit": limit,
            "lines": ["request completed with HTTP 200"],
            "truncated": False,
        }


def request_context(hypothesis_id="parser-contract"):
    return {
        "reason": "Determine why the successful response has no structured tool call.",
        "hypothesis_id": hypothesis_id,
        "expected_information_gain": "Distinguish generation failure from parser failure.",
    }


def successful_turns(*, with_repair_plan=False):
    context = request_context()
    repair = None
    if with_repair_plan:
        repair = {
            "hypothesis_id": "parser-contract",
            "confidence": 0.95,
            "evidence": ["ev-001", "ev-002", "ev-003"],
            "action": {
                "tool": "patch_serving_config",
                "arguments": {
                    "service": "target-a",
                    "approved_profile": "qwen-tools-matched-v1",
                },
            },
            "expected_effect": "Structured tool calls are restored.",
            "risk": "The target service restarts.",
            "verification_plan": ["readiness", "visible_tool_canary"],
            "rollback_plan": "Restore the captured launch configuration.",
        }
    final = {
        "state": "PLAN",
        "summary": "The generated call format is incompatible with the active parser/template contract.",
        "hypotheses": [
            {
                "id": "parser-contract",
                "confidence": 0.95,
                "supports": ["ev-001", "ev-002", "ev-003"],
                "contradicts": [],
            }
        ],
        "stop_reason": None,
    }
    if repair is not None:
        final["repair_plan"] = repair
    return [
        ModelTurn(
            tool_calls=(
                ToolCall(
                    "call-1",
                    "run_canary",
                    {**context, "case": "visible_tool_call"},
                ),
            )
        ),
        ModelTurn(
            tool_calls=(
                ToolCall(
                    "call-2",
                    "read_raw_generation",
                    {**context, "request_id": "req-184"},
                ),
                ToolCall(
                    "call-3",
                    "get_launch_config",
                    {**context, "service": "target-a"},
                ),
            )
        ),
        ModelTurn(content=json.dumps(final)),
    ]


class AgentRuntimeTests(unittest.TestCase):
    def make_controller(
        self,
        root,
        client,
        backend=None,
        repository=None,
        repair_precheck=None,
    ):
        backend = backend or FakeDiagnosticBackend()
        return AgentController(
            run_id="context-run",
            client=client,
            tools=DiagnosticToolRegistry(backend, repository=repository),
            evidence=EvidenceLedger(root / "artifacts"),
            event_log=JsonlEventLog(root / "events.jsonl", "context-run"),
            repair_precheck=repair_precheck,
        )

    def test_diagnosis_expands_context_and_cites_real_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = ScriptedNemotronClient(successful_turns())
            result = self.make_controller(root, client).run(
                "The target returns HTTP 200 but the visible tool canary fails."
            )

            self.assertEqual(result.decision.state, "PLAN")
            self.assertEqual(result.state, "PLAN")
            self.assertEqual(result.expansion_rounds, 2)
            self.assertEqual(result.tool_calls, 3)
            self.assertEqual(
                [record.source_type for record in result.evidence],
                ["functional_canary", "raw_generation", "serving_config"],
            )
            events = [
                json.loads(line)
                for line in (root / "events.jsonl").read_text().splitlines()
            ]
            requests = [e for e in events if e["event_type"] == "context_requested"]
            self.assertEqual(len(requests), 3)
            self.assertEqual(requests[0]["payload"]["hypothesis_id"], "parser-contract")
            tool_payload = json.loads(client.requests[-1]["messages"][-1]["content"])
            self.assertEqual(tool_payload["evidence"]["evidence_id"], "ev-003")

    def test_approved_repair_plan_transitions_to_precheck(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = FakeDiagnosticBackend()
            policy = RepairPolicy(
                allowed_services=("target-a",),
                approved_profiles=(
                    ApprovedServingProfile(
                        name="qwen-tools-matched-v1",
                        tool_call_parser="hermes",
                        chat_template="qwen-tools-hermes",
                    ),
                ),
            )
            tokens = iter(("001", "rollback-001"))
            precheck = RepairPrecheck(
                policy,
                backend,
                token_factory=lambda: next(tokens),
            )
            controller = self.make_controller(
                root,
                ScriptedNemotronClient(successful_turns(with_repair_plan=True)),
                backend=backend,
                repair_precheck=precheck,
            )

            result = controller.run(
                "The target returns HTTP 200 but the visible tool canary fails."
            )

            self.assertEqual(result.decision.state, "PLAN")
            self.assertEqual(result.state, "PRECHECK")
            self.assertEqual(result.precheck.policy.status, "APPROVED")
            self.assertEqual(result.precheck.approval.change_id, "chg-001")
            self.assertEqual(
                result.precheck.approval.rollback_token,
                "rb-rollback-001",
            )
            events = [
                json.loads(line)
                for line in (root / "events.jsonl").read_text().splitlines()
            ]
            self.assertIn(
                {"from": "PLAN", "to": "PRECHECK"},
                [
                    event["payload"]
                    for event in events
                    if event["event_type"] == "state_transition"
                ],
            )

    def test_fabricated_evidence_reference_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ScriptedNemotronClient(
                [
                    ModelTurn(
                        content=json.dumps(
                            {
                                "state": "PLAN",
                                "summary": "Unsupported diagnosis.",
                                "hypotheses": [
                                    {
                                        "id": "guess",
                                        "confidence": 0.9,
                                        "supports": ["ev-999"],
                                        "contradicts": [],
                                    }
                                ],
                                "stop_reason": None,
                            }
                        )
                    )
                ]
            )
            controller = self.make_controller(Path(directory), client)
            with self.assertRaisesRegex(ContractError, "unknown evidence"):
                controller.run("Diagnose the incident.")

    def test_context_metadata_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ScriptedNemotronClient(
                [
                    ModelTurn(
                        tool_calls=(
                            ToolCall(
                                "call-1",
                                "run_canary",
                                {"case": "visible_tool_call"},
                            ),
                        )
                    )
                ]
            )
            controller = self.make_controller(Path(directory), client)
            with self.assertRaisesRegex(ContractError, "missing arguments"):
                controller.run("Diagnose the incident.")

    def test_blank_context_reason_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ScriptedNemotronClient(
                [
                    ModelTurn(
                        tool_calls=(
                            ToolCall(
                                "call-1",
                                "run_canary",
                                {
                                    **request_context(),
                                    "reason": "   ",
                                    "case": "visible_tool_call",
                                },
                            ),
                        )
                    )
                ]
            )
            controller = self.make_controller(Path(directory), client)
            with self.assertRaisesRegex(ContractError, "reason must be"):
                controller.run("Diagnose the incident.")

    def test_duplicate_tool_call_ids_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            context = request_context()
            client = ScriptedNemotronClient(
                [
                    ModelTurn(
                        tool_calls=(
                            ToolCall("same", "get_status", context),
                            ToolCall(
                                "same",
                                "run_canary",
                                {**context, "case": "visible_tool_call"},
                            ),
                        )
                    )
                ]
            )
            controller = self.make_controller(Path(directory), client)
            with self.assertRaisesRegex(ContractError, "IDs must be unique"):
                controller.run("Diagnose the incident.")

    def test_third_identical_request_is_blocked_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            context = request_context()
            repeated = ModelTurn(
                tool_calls=(
                    ToolCall(
                        "call-repeat",
                        "run_canary",
                        {**context, "case": "visible_tool_call"},
                    ),
                )
            )
            backend = FakeDiagnosticBackend()
            controller = self.make_controller(
                Path(directory),
                ScriptedNemotronClient([repeated, repeated, repeated]),
                backend,
            )
            with self.assertRaisesRegex(BudgetExceeded, "repeated context request"):
                controller.run("Diagnose the incident.")
            self.assertEqual(backend.canary_runs, 2)

    def test_log_limit_is_enforced_by_tool_schema(self):
        tools = DiagnosticToolRegistry(FakeDiagnosticBackend())
        with self.assertRaisesRegex(ContractError, "at most 200"):
            tools.invoke(
                "read_logs",
                {
                    **request_context(),
                    "service": "target-a",
                    "since": "10m",
                    "pattern": "",
                    "limit": 201,
                },
            )

    def test_unknown_service_is_rejected_before_backend_call(self):
        tools = DiagnosticToolRegistry(FakeDiagnosticBackend())
        with self.assertRaisesRegex(ContractError, "must be one of"):
            tools.invoke(
                "get_launch_config",
                {**request_context(), "service": "arbitrary-container"},
            )

    def test_source_content_is_marked_untrusted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "repository" / "nexus"
            source.mkdir(parents=True)
            (source / "parser.py").write_text("PARSER = 'hermes'\n", encoding="utf-8")
            repository = BoundedRepository(
                root / "repository", allowed_roots=("nexus",)
            )
            context = request_context()
            client = ScriptedNemotronClient(
                [
                    ModelTurn(
                        tool_calls=(
                            ToolCall(
                                "call-file",
                                "read_file",
                                {
                                    **context,
                                    "path": "nexus/parser.py",
                                    "start_line": 1,
                                    "end_line": 1,
                                },
                            ),
                        )
                    ),
                    ModelTurn(
                        content=json.dumps(
                            {
                                "state": "ABSTAIN",
                                "summary": "More runtime evidence is required.",
                                "hypotheses": [],
                                "stop_reason": "insufficient runtime evidence",
                            }
                        )
                    ),
                ]
            )
            result = self.make_controller(root, client, repository=repository).run(
                "Inspect only the relevant parser source."
            )

            self.assertEqual(result.evidence[0].trust, "untrusted")
            tool_payload = json.loads(client.requests[-1]["messages"][-1]["content"])
            self.assertIn("UNTRUSTED DATA", tool_payload["instruction_boundary"])


if __name__ == "__main__":
    unittest.main()
