import json
import tempfile
import unittest
from pathlib import Path

from nexus.agent.budgets import BudgetExceeded, RunBudget
from nexus.agent.contracts import ModelTurn, ToolCall
from nexus.agent.tool_loop import ToolLoopController
from nexus.infrastructure.events import JsonlEventLog
from nexus.infrastructure.nemotron import ScriptedNemotronClient
from nexus.tools.registry import ToolDefinition, ToolRegistry


def registry():
    return ToolRegistry([ToolDefinition("describe_environment", "Describe capabilities.", {"type": "object", "properties": {}, "additionalProperties": False}, lambda args: {"id": "test", "resources": []})])


def successful_client():
    return ScriptedNemotronClient([
        ModelTurn(tool_calls=(ToolCall("call-1", "describe_environment", {}),)),
        ModelTurn(content=json.dumps({"state": "DIAGNOSE", "summary": "Capabilities collected.", "hypotheses": [], "stop_reason": None})),
    ])


class ToolLoopTests(unittest.TestCase):
    def test_three_clean_contract_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(3):
                run_id = f"run-{index}"
                path = root / run_id / "events.jsonl"
                result = ToolLoopController(run_id=run_id, client=successful_client(), tools=registry(), event_log=JsonlEventLog(path, run_id)).run("Inspect capabilities.")
                self.assertEqual((result.decision.state, result.steps, result.tool_calls), ("DIAGNOSE", 2, 1))
                events = [json.loads(line) for line in path.read_text().splitlines()]
                self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))
                self.assertEqual(events[-1]["event_type"], "run_completed")

    def test_reopened_event_log_continues_sequence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            JsonlEventLog(path, "same-run").append("first", {})
            JsonlEventLog(path, "same-run").append("second", {})
            events = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual([event["sequence"] for event in events], [1, 2])

    def test_tool_and_combined_budgets_are_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ScriptedNemotronClient([ModelTurn(tool_calls=(ToolCall("call-1", "describe_environment", {}), ToolCall("call-2", "describe_environment", {})))])
            controller = ToolLoopController(run_id="budget-run", client=client, tools=registry(), event_log=JsonlEventLog(Path(directory) / "events.jsonl", "budget-run"), budget=RunBudget(max_steps=2, max_tool_calls=1))
            with self.assertRaises(BudgetExceeded): controller.run("Inspect capabilities.")
        budget = RunBudget(max_steps=10, max_tool_calls=10, max_total_operations=2)
        budget.consume_step(); budget.consume_tool_call()
        with self.assertRaisesRegex(BudgetExceeded, "total operation budget"): budget.consume_step()


if __name__ == "__main__":
    unittest.main()
