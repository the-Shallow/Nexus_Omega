import json
import tempfile
import unittest
from pathlib import Path

from nexus.agent import structured as flow
from nexus.agent.contracts import DiagnosticInput, ModelTurn
from nexus.agent.controller import AgentController
from nexus.agent.evidence import EvidenceLedger
from nexus.infrastructure.events import JsonlEventLog
from nexus.infrastructure.nemotron import ScriptedNemotronClient
from nexus.tools.environment import EnvironmentTools
from nexus.tools.manifest import EnvironmentManifest

PROFILE = {"type": "object", "additionalProperties": False, "required": ["profile"],
           "properties": {"profile": {"type": "string", "enum": ["reviewed"]}}}
EMPTY = {"type": "object", "additionalProperties": False, "properties": {}}


def fleet():
    targets = ["target-a", "target-b"]
    return EnvironmentManifest.from_dict({
        "id": "fleet", "description": "Two workers behind an entry point.",
        "resources": [{"id": r, "kind": "service", "description": "Worker.", "configuration_keys": ["parser"],
                       "metrics": ["latency"]} for r in targets],
        "probes": [{"id": "check", "description": "Check.", "inputs": EMPTY}],
        "fault_classes": {"none": "healthy", "misconfigured": "config differs", "crashed": "not running",
                          "network_path": "path impaired", "unknown": "unclear"},
        "actions": [
            {"id": "apply-profile", "description": "Relaunch with a reviewed profile.", "allowed_targets": targets,
             "parameters": PROFILE, "automatic": True, "addresses": ["misconfigured"], "removes_capacity": True},
            {"id": "restart", "description": "Relaunch as is.", "allowed_targets": targets, "parameters": EMPTY,
             "automatic": True, "addresses": ["crashed"], "removes_capacity": True},
            {"id": "drain", "description": "Stop routing to it.", "allowed_targets": targets, "parameters": EMPTY,
             "automatic": True, "addresses": ["network_path"], "removes_capacity": True, "restores_service": False},
            {"id": "undrain", "description": "Return to rotation.", "allowed_targets": targets, "parameters": EMPTY,
             "automatic": False},
        ],
        "verifiers": ["hidden-check"],
    })


def row(status, fault, evidence=("ev-001",)):
    return {"finding": f"{status} ({fault})", "status": status, "fault_class": fault, "evidence": list(evidence)}


def assessment(a, b):
    return {"observations": "Compared both workers.", "assessments": {"target-a": a, "target-b": b}}


class MenuTests(unittest.TestCase):
    def test_menu_only_offers_fitting_actions_on_faulty_resources(self):
        moves = flow.build_moves(fleet(), assessment(row("failed", "misconfigured"), row("healthy", "none")),
                                 {"target-a": True, "target-b": True})
        self.assertEqual([m.move_id for m in moves], ["apply-profile target-a reviewed"])
        self.assertIn("no_action", flow.choose_format(moves)["json_schema"]["schema"]["properties"]["move"]["enum"])

    def test_draining_the_link_first_is_marked_do_after(self):
        moves = flow.build_moves(fleet(), assessment(row("failed", "misconfigured"), row("degraded", "network_path")),
                                 {"target-a": True, "target-b": True})
        notes = {m.move_id: m.note for m in moves}
        self.assertIsNone(notes["apply-profile target-a reviewed"])
        self.assertIn("do this after repairing target-a", notes["drain target-b"])

    def test_repair_with_nothing_else_serving_is_blocked(self):
        moves = flow.build_moves(fleet(), assessment(row("failed", "misconfigured"), row("failed", "crashed")),
                                 {"target-a": True, "target-b": False})
        by_id = {m.move_id: m for m in moves}
        self.assertTrue(by_id["apply-profile target-a reviewed"].blocked)
        self.assertFalse(by_id["restart target-b"].blocked)
        offered = flow.choose_format(moves)["json_schema"]["schema"]["properties"]["move"]["enum"]
        self.assertNotIn("apply-profile target-a reviewed", offered)

    def test_contradictions_are_named_and_coerced(self):
        bad = assessment(row("healthy", "crashed"), row("failed", "none"))
        self.assertEqual(len(flow.assessment_errors(bad)), 2)
        fixed = flow.coerce(bad)["assessments"]
        self.assertEqual((fixed["target-a"]["fault_class"], fixed["target-b"]["fault_class"]), ("none", "unknown"))


class Serving:
    def __init__(self, up): self.up = up
    def get_resource_state(self, resource_id, fields): return {"state": {"serving": self.up[resource_id]}}


def run(turns, serving=None):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        client = ScriptedNemotronClient(turns)
        controller = AgentController(
            run_id="run-structured", client=client, tools=EnvironmentTools(Serving({}), fleet()),
            evidence=EvidenceLedger(root), event_log=JsonlEventLog(root / "events.jsonl", "run-structured"),
            structured=True, provider=Serving(serving) if serving else None)
        trigger = DiagnosticInput.from_dict({
            "trigger_id": "t-1", "summary": "Health check.", "observed_at": "2026-10-18T05:00:00Z",
            "affected_resources": ["target-a", "target-b"], "human_context": None,
            "initial_observations": [{"source_type": "probe_result", "source": "probe:check:1",
                                      "finding": "Snapshot.", "content": {"ok": True}, "trust": "trusted"}]})
        return controller.run(trigger), client


class StructuredControllerTests(unittest.TestCase):
    def test_all_healthy_ends_in_abstain_without_a_choice(self):
        result, client = run([
            ModelTurn(content="Both workers look normal."),
            ModelTurn(content=json.dumps(assessment(row("healthy", "none"), row("healthy", "none")))),
        ])
        self.assertEqual(result.state, "ABSTAIN")
        self.assertIn("no fault found", result.decision.stop_reason)
        self.assertIsNone(result.decision.repair_plan)
        self.assertEqual(len(client.requests), 2)  # never asked to choose a move

    def test_chosen_move_becomes_a_plan_for_the_assessed_target(self):
        result, client = run([
            ModelTurn(content="target-a's parser differs."),
            ModelTurn(content=json.dumps(assessment(row("failed", "misconfigured"), row("healthy", "none")))),
            ModelTurn(content=json.dumps({"reasoning": "Repair a.", "move": "apply-profile target-a reviewed",
                                          "expected_effect": "Tool calls work.", "risk": "Brief restart."})),
        ], serving={"target-a": True, "target-b": True})
        # No precheck is configured here, so a plan stops at REQUIRES_APPROVAL; the decision is the point.
        self.assertEqual((result.state, result.decision.state), ("REQUIRES_APPROVAL", "PLAN"))
        action = result.decision.repair_plan.action.arguments
        self.assertEqual((action["action_id"], action["target"], action["parameters"]),
                         ("apply-profile", "target-a", {"profile": "reviewed"}))
        self.assertEqual(result.decision.hypotheses[0].hypothesis_id, "target-a:misconfigured")

    def test_no_action_choice_abstains(self):
        result, _ = run([
            ModelTurn(content="Something is off on b."),
            ModelTurn(content=json.dumps(assessment(row("healthy", "none"), row("degraded", "unknown")))),
        ])
        # unknown has no fitting action, so there is nothing to choose: a human is needed.
        self.assertEqual(result.state, "ABSTAIN")
        self.assertIn("requires a human", result.decision.stop_reason)

    def test_unparseable_assessment_twice_abstains_instead_of_crashing(self):
        result, _ = run([ModelTurn(content="Done."), ModelTurn(content="not json"), ModelTurn(content="still not")])
        self.assertEqual((result.state, result.decision.stop_reason), ("ABSTAIN", "assessment_failed"))


if __name__ == "__main__":
    unittest.main()
