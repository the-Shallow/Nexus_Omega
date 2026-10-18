import json
import tempfile
import unittest
from pathlib import Path

from nexus.agent.budgets import BudgetExceeded
from nexus.agent.contracts import (
    ContractError,
    DiagnosticInput,
    ModelTurn,
    ToolCall,
)
from nexus.agent.controller import AgentController
from nexus.agent.evidence import EvidenceLedger
from nexus.agent.policy import RepairPolicy, RepairPrecheck
from nexus.infrastructure.events import JsonlEventLog
from nexus.infrastructure.nemotron import ScriptedNemotronClient
from nexus.infrastructure.repository import BoundedRepository
from nexus.tools.environment import EnvironmentTools
from nexus.tools.manifest import EnvironmentManifest


def manifest():
    return EnvironmentManifest.from_dict({
        "id": "runtime-test", "description": "General controller test environment.",
        "resources": [{"id": "target-a", "kind": "service", "description": "Test service.", "configuration_keys": ["mode", "template"], "metrics": ["error_rate"]}],
        "probes": [{"id": "contract-check", "description": "Exercise the external contract.", "inputs": {"type": "object", "properties": {"case": {"type": "string", "enum": ["visible-operation"]}}, "required": ["case"], "additionalProperties": False}}],
        "actions": [{"id": "set-runtime-profile", "description": "Apply reviewed profile.", "allowed_targets": ["target-a"], "parameters": {"type": "object", "properties": {"profile": {"type": "string", "enum": ["matched-v1"]}}, "required": ["profile"], "additionalProperties": False}, "before_state_keys": ["mode", "template"], "automatic": True, "requires_rollback": True}],
        "artifact_sections": ["raw_output"], "verifiers": ["contract-check"],
    })


class FakeEnvironmentProvider:
    def __init__(self): self.probe_runs = 0
    def list_resources(self): return {"resources": [{"id": "target-a", "status": "ready"}]}
    def get_resource_state(self, resource_id, fields): return {"resource_id": resource_id, "values": {key: "ready" for key in fields}}
    def get_configuration(self, resource_id, keys): return {"resource_id": resource_id, "values": {"mode": "legacy", "template": "default"}}
    def query_logs(self, resource_id, since, query, limit): return {"lines": [], "truncated": False}
    def query_metrics(self, resource_id, metric, window): return {"metric": metric, "value": 0}
    def run_probe(self, probe_id, inputs):
        self.probe_runs += 1
        return {"observation_id": "obs-184", "artifact_id": "artifact-184", "passed": False, "structured_operations": 0}
    def read_artifact(self, artifact_id, section): return {"artifact_id": artifact_id, "section": section, "text": '{"name":"lookup","arguments":{}}'}


def context(hypothesis_id="runtime-contract"):
    return {"reason": "Determine why the external contract failed.", "hypothesis_id": hypothesis_id, "expected_information_gain": "Separate generation from configuration failure."}


def diagnostic_input(summary="Diagnose the reported problem.", *, observations=None, resources=None):
    return DiagnosticInput.from_dict({
        "trigger_id": "trigger-184",
        "summary": summary,
        "observed_at": "2026-10-17T14:22:31Z",
        "affected_resources": resources if resources is not None else ["target-a"],
        "initial_observations": observations or [],
        "human_context": "Investigate without assuming a root cause.",
        "time_window": "10m",
        "correlation_ids": {"request_id": "req-184"},
    })


def successful_turns(*, with_repair=False):
    repair = None
    if with_repair:
        repair = {
            "hypothesis_id": "runtime-contract", "confidence": 0.95, "evidence": ["ev-001", "ev-002", "ev-003"],
            "action": {"tool": "apply_action", "arguments": {"action_id": "set-runtime-profile", "target": "target-a", "parameters": {"profile": "matched-v1"}}},
            "expected_effect": "The contract probe succeeds.", "risk": "The resource may restart.",
            "verification_plan": ["run contract-check"], "rollback_plan": "Restore captured state.",
        }
    final = {"state": "PLAN", "summary": "Generated output conflicts with effective runtime configuration.", "hypotheses": [{"id": "runtime-contract", "confidence": 0.95, "supports": ["ev-001", "ev-002", "ev-003"], "contradicts": []}], "stop_reason": None}
    if repair: final["repair_plan"] = repair
    return [
        ModelTurn(tool_calls=(ToolCall("call-1", "run_probe", {**context(), "probe_id": "contract-check", "inputs": {"case": "visible-operation"}}),)),
        ModelTurn(tool_calls=(ToolCall("call-2", "read_artifact", {**context(), "artifact_id": "artifact-184", "section": "raw_output"}), ToolCall("call-3", "get_configuration", {**context(), "resource_id": "target-a", "keys": ["mode", "template"]}))),
        ModelTurn(content=json.dumps(final)),
    ]


class AgentRuntimeTests(unittest.TestCase):
    def make_controller(self, root, client, provider=None, repository=None, precheck=None):
        provider = provider or FakeEnvironmentProvider()
        return AgentController(run_id="context-run", client=client, tools=EnvironmentTools(provider, manifest(), repository=repository), evidence=EvidenceLedger(root / "artifacts"), event_log=JsonlEventLog(root / "events.jsonl", "context-run"), repair_precheck=precheck)

    def test_diagnosis_expands_context_and_cites_real_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); client = ScriptedNemotronClient(successful_turns())
            result = self.make_controller(root, client).run(diagnostic_input("The public operation contract fails while the resource remains available."))
            self.assertEqual((result.state, result.expansion_rounds, result.tool_calls), ("PLAN", 2, 3))
            self.assertEqual([record.source_type for record in result.evidence], ["probe_result", "artifact", "configuration"])
            requests = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines() if '"event_type":"context_requested"' in line]
            self.assertEqual(len(requests), 3)
            payload = json.loads(client.requests[-1]["messages"][-1]["content"])
            self.assertEqual(payload["evidence"]["evidence_id"], "ev-003")

    def test_declared_repair_transitions_to_precheck(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); provider = FakeEnvironmentProvider(); tokens = iter(("001", "rollback-001"))
            precheck = RepairPrecheck(RepairPolicy(manifest()), provider, token_factory=lambda: next(tokens))
            result = self.make_controller(root, ScriptedNemotronClient(successful_turns(with_repair=True)), provider, precheck=precheck).run(diagnostic_input("Diagnose contract failure."))
            self.assertEqual(result.state, "PRECHECK")
            self.assertEqual(result.precheck.approval.action_id, "set-runtime-profile")

    def test_repair_called_as_a_tool_is_redirected_to_a_plan(self):
        # Seen live with Nemotron Lightning: after gathering evidence it *called*
        # apply_action (parameters as a JSON string) instead of returning a PLAN.
        turns = successful_turns(with_repair=True)
        plan = turns[-1]
        repair_call = ModelTurn(tool_calls=(ToolCall("call-4", "apply_action", {
            "action_id": "set-runtime-profile", "target": "target-a",
            "parameters": json.dumps({"profile": "matched-v1"})}),))
        client = ScriptedNemotronClient([*turns[:-1], repair_call, plan])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); provider = FakeEnvironmentProvider(); tokens = iter(("002", "rollback-002"))
            precheck = RepairPrecheck(RepairPolicy(manifest()), provider, token_factory=lambda: next(tokens))
            result = self.make_controller(root, client, provider, precheck=precheck).run(diagnostic_input("Diagnose contract failure."))
            events = [json.loads(line)["event_type"] for line in (root / "events.jsonl").read_text().splitlines()]
        self.assertEqual(result.state, "PRECHECK")
        self.assertEqual(result.expansion_rounds, 2)
        self.assertIn("repair_tool_call_redirected", events)
        final_request = client.requests[-1]
        self.assertEqual(final_request["tools"], [])
        self.assertEqual(final_request["response_format"]["type"], "json_schema")
        note = json.loads(final_request["messages"][-1]["content"])
        self.assertEqual(note["status"], "not_executed")

    def test_string_parameters_in_a_plan_are_parsed(self):
        turns = successful_turns(with_repair=True)
        final = json.loads(turns[-1].content)
        final["repair_plan"]["action"]["arguments"]["parameters"] = json.dumps({"profile": "matched-v1"})
        client = ScriptedNemotronClient([*turns[:-1], ModelTurn(content=json.dumps(final))])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); provider = FakeEnvironmentProvider(); tokens = iter(("003", "rollback-003"))
            precheck = RepairPrecheck(RepairPolicy(manifest()), provider, token_factory=lambda: next(tokens))
            result = self.make_controller(root, client, provider, precheck=precheck).run(diagnostic_input("Diagnose contract failure."))
        self.assertEqual(result.state, "PRECHECK")
        self.assertEqual(result.precheck.approval.parameters, {"profile": "matched-v1"})

    def test_unknown_citation_gets_one_retry_limited_to_issued_evidence(self):
        turns = successful_turns(with_repair=True)
        bad = json.loads(turns[-1].content)
        bad["hypotheses"][0]["supports"] = ["tool_call_parser mismatch between target-a and target-b"]
        client = ScriptedNemotronClient([*turns[:-1], ModelTurn(content=json.dumps(bad)), turns[-1]])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); provider = FakeEnvironmentProvider(); tokens = iter(("004", "rollback-004"))
            precheck = RepairPrecheck(RepairPolicy(manifest()), provider, token_factory=lambda: next(tokens))
            result = self.make_controller(root, client, provider, precheck=precheck).run(diagnostic_input("Diagnose contract failure."))
        self.assertEqual(result.state, "PRECHECK")
        schema = client.requests[-1]["response_format"]["json_schema"]["schema"]
        cite = schema["properties"]["hypotheses"]["items"]["properties"]["supports"]["items"]
        self.assertEqual(cite["enum"], ["ev-001", "ev-002", "ev-003"])
        self.assertEqual(schema["properties"]["state"]["enum"], ["PLAN", "ABSTAIN"])

    def test_context_budget_ends_in_a_decision_not_a_crash(self):
        probe = lambda i: ModelTurn(tool_calls=(ToolCall(f"call-{i}", "query_metrics", {**context(), "resource_id": "target-a", "metric": "error_rate", "window": f"{i}m"}),))
        abstain = ModelTurn(content=json.dumps({"state": "ABSTAIN", "summary": "Not enough evidence.", "hypotheses": [], "stop_reason": "context budget reached"}))
        client = ScriptedNemotronClient([*(probe(i) for i in range(1, 10)), abstain])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.make_controller(root, client).run(diagnostic_input())
            events = [json.loads(line)["event_type"] for line in (root / "events.jsonl").read_text().splitlines()]
        self.assertEqual((result.state, result.expansion_rounds), ("ABSTAIN", 8))
        self.assertIn("context_budget_reached", events)
        self.assertEqual(client.requests[-1]["tools"], [])

    def test_default_budgets_allow_eight_expansion_rounds(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = self.make_controller(Path(directory), ScriptedNemotronClient([]))
        self.assertEqual(controller.context_budget.max_rounds, 8)
        # Each round is a model step plus at least one tool call.
        self.assertGreaterEqual(controller.run_budget.max_total_operations, 2 * 8 + 2)

    def test_fabricated_evidence_and_missing_context_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            unsupported = ModelTurn(content=json.dumps({"state": "PLAN", "summary": "Guess.", "hypotheses": [{"id": "guess", "confidence": 0.9, "supports": ["ev-999"], "contradicts": []}], "stop_reason": None}))
            # A rejected decision gets one schema-guided retry; fabricating again still fails.
            with self.assertRaisesRegex(ContractError, "unknown evidence"):
                self.make_controller(Path(directory), ScriptedNemotronClient([unsupported, unsupported])).run(diagnostic_input())
        with tempfile.TemporaryDirectory() as directory:
            call = ModelTurn(tool_calls=(ToolCall("call-1", "run_probe", {"probe_id": "contract-check", "inputs": {"case": "visible-operation"}}),))
            with self.assertRaisesRegex(ContractError, "missing arguments"):
                self.make_controller(Path(directory), ScriptedNemotronClient([call])).run(diagnostic_input())

    def test_repeated_request_is_bounded_before_third_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeEnvironmentProvider()
            turns = [ModelTurn(tool_calls=(ToolCall(f"call-{i}", "run_probe", {**context(), "probe_id": "contract-check", "inputs": {"case": "visible-operation"}}),)) for i in range(3)]
            with self.assertRaisesRegex(BudgetExceeded, "repeated context request"):
                self.make_controller(Path(directory), ScriptedNemotronClient(turns), provider).run(diagnostic_input())
            self.assertEqual(provider.probe_runs, 2)

    def test_logs_and_repository_content_are_bounded_and_untrusted(self):
        tools = EnvironmentTools(FakeEnvironmentProvider(), manifest())
        with self.assertRaisesRegex(ContractError, "at most 200"):
            tools.invoke("query_logs", {**context(), "resource_id": "target-a", "since": "10m", "query": "", "limit": 201})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "repo" / "app"; source.mkdir(parents=True); (source / "config.py").write_text("MODE = 'legacy'\n", encoding="utf-8")
            repository = BoundedRepository(root / "repo", allowed_roots=("app",))
            client = ScriptedNemotronClient([ModelTurn(tool_calls=(ToolCall("call-file", "read_file", {**context(), "path": "app/config.py", "start_line": 1, "end_line": 1}),)), ModelTurn(content=json.dumps({"state": "ABSTAIN", "summary": "Runtime evidence is needed.", "hypotheses": [], "stop_reason": "insufficient evidence"}))])
            result = self.make_controller(root, client, repository=repository).run(diagnostic_input("Inspect relevant source."))
            self.assertEqual(result.evidence[0].trust, "untrusted")
            payload = json.loads(client.requests[-1]["messages"][-1]["content"])
            self.assertIn("UNTRUSTED DATA", payload["instruction_boundary"])

    def test_initial_observations_are_seeded_before_the_first_model_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = ScriptedNemotronClient([
                ModelTurn(content=json.dumps({
                    "state": "PLAN",
                    "summary": "The initial metric supports a capacity hypothesis.",
                    "hypotheses": [{"id": "capacity", "confidence": 0.8, "supports": ["ev-001"], "contradicts": []}],
                    "stop_reason": None,
                }))
            ])
            trigger = diagnostic_input(
                "GPU memory saturation was detected.",
                observations=[{
                    "source_type": "metric",
                    "source": "target-a:gpu-memory",
                    "finding": "GPU memory reached 99 percent.",
                    "content": {"value": 99, "unit": "percent"},
                    "trust": "trusted",
                    "resource_id": "target-a",
                    "observed_at": "2026-10-17T14:22:30Z",
                }],
            )
            result = self.make_controller(root, client).run(trigger)
            self.assertEqual(result.evidence[0].source_type, "metric")
            first_user_message = json.loads(client.requests[0]["messages"][1]["content"])
            self.assertEqual(first_user_message["trigger"]["trigger_id"], "trigger-184")
            self.assertEqual(first_user_message["initial_evidence"][0]["evidence"]["evidence_id"], "ev-001")

    def test_undeclared_input_resource_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = self.make_controller(
                Path(directory), ScriptedNemotronClient([])
            )
            with self.assertRaisesRegex(ContractError, "undeclared resources"):
                controller.run(diagnostic_input(resources=["unknown-worker"]))


if __name__ == "__main__":
    unittest.main()
