import json
import tempfile
import unittest
from pathlib import Path

from nexus.agent.budgets import BudgetExceeded, RunBudget
from nexus.agent.client import ScriptedNemotronClient
from nexus.agent.contracts import ModelTurn, ToolCall
from nexus.agent.events import JsonlEventLog
from nexus.agent.runtime import CheckpointZeroController
from nexus.agent.tools import build_checkpoint_zero_registry


def successful_client() -> ScriptedNemotronClient:
    return ScriptedNemotronClient(
        [
            ModelTurn(
                tool_calls=(
                    ToolCall("call-1", "get_topology", {}),
                )
            ),
            ModelTurn(
                content=json.dumps(
                    {
                        "state": "DIAGNOSE",
                        "summary": "Topology collected.",
                        "hypotheses": [],
                        "stop_reason": None,
                    }
                )
            ),
        ]
    )


class RuntimeTests(unittest.TestCase):
    def test_three_clean_contract_runs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(3):
                run_id = f"run-{index}"
                path = root / run_id / "events.jsonl"
                controller = CheckpointZeroController(
                    run_id=run_id,
                    client=successful_client(),
                    tools=build_checkpoint_zero_registry(),
                    event_log=JsonlEventLog(path, run_id),
                )
                result = controller.run("Inspect topology.")
                self.assertEqual(result.decision.state, "DIAGNOSE")
                self.assertEqual(result.steps, 2)
                self.assertEqual(result.tool_calls, 1)
                events = [json.loads(line) for line in path.read_text().splitlines()]
                self.assertEqual(
                    [event["sequence"] for event in events],
                    list(range(1, len(events) + 1)),
                )
                self.assertEqual(events[-1]["event_type"], "run_completed")

    def test_reopened_event_log_continues_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            JsonlEventLog(path, "same-run").append("first", {})
            JsonlEventLog(path, "same-run").append("second", {})
            events = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual([event["sequence"] for event in events], [1, 2])

    def test_tool_budget_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = ScriptedNemotronClient(
                [
                    ModelTurn(
                        tool_calls=(
                            ToolCall("call-1", "get_topology", {}),
                            ToolCall("call-2", "get_topology", {}),
                        )
                    )
                ]
            )
            controller = CheckpointZeroController(
                run_id="budget-run",
                client=client,
                tools=build_checkpoint_zero_registry(),
                event_log=JsonlEventLog(Path(directory) / "events.jsonl", "budget-run"),
                budget=RunBudget(max_steps=2, max_tool_calls=1),
            )
            with self.assertRaises(BudgetExceeded):
                controller.run("Inspect topology.")


if __name__ == "__main__":
    unittest.main()
