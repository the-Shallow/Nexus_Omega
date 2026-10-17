import json
import unittest

from nexus.agent.contracts import AgentDecision, ContractError, ModelTurn


class ContractTests(unittest.TestCase):
    def test_native_tool_call_is_decoded(self) -> None:
        turn = ModelTurn.from_vllm_message(
            {
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "get_topology", "arguments": "{}"},
                    }
                ],
            }
        )
        self.assertEqual(turn.tool_calls[0].name, "get_topology")
        self.assertEqual(turn.tool_calls[0].arguments, {})

    def test_malformed_tool_arguments_are_rejected(self) -> None:
        with self.assertRaisesRegex(ContractError, "not valid JSON"):
            ModelTurn.from_vllm_message(
                {
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "get_topology",
                                "arguments": "{broken",
                            },
                        }
                    ]
                }
            )

    def test_valid_decision_is_decoded(self) -> None:
        decision = AgentDecision.from_json(
            json.dumps(
                {
                    "state": "DIAGNOSE",
                    "summary": "Topology collected.",
                    "hypotheses": [],
                    "stop_reason": None,
                }
            )
        )
        self.assertEqual(decision.state, "DIAGNOSE")

    def test_unknown_decision_field_is_rejected(self) -> None:
        with self.assertRaisesRegex(ContractError, "unsupported fields"):
            AgentDecision.from_json(
                json.dumps(
                    {
                        "state": "DIAGNOSE",
                        "summary": "Topology collected.",
                        "hypotheses": [],
                        "stop_reason": None,
                        "command": "do something unsafe",
                    }
                )
            )

    def test_missing_decision_field_is_rejected(self) -> None:
        with self.assertRaisesRegex(ContractError, "missing required fields"):
            AgentDecision.from_json(
                json.dumps(
                    {
                        "state": "DIAGNOSE",
                        "summary": "Topology collected.",
                        "hypotheses": [],
                    }
                )
            )

    def test_repair_plan_is_decoded(self) -> None:
        decision = AgentDecision.from_json(
            json.dumps(
                {
                    "state": "PLAN",
                    "summary": "A matched serving profile is required.",
                    "hypotheses": [
                        {
                            "id": "parser-contract",
                            "confidence": 0.95,
                            "supports": ["ev-001"],
                            "contradicts": [],
                        }
                    ],
                    "stop_reason": None,
                    "repair_plan": {
                        "hypothesis_id": "parser-contract",
                        "confidence": 0.95,
                        "evidence": ["ev-001"],
                        "action": {
                            "tool": "patch_serving_config",
                            "arguments": {
                                "service": "target-a",
                                "approved_profile": "qwen-tools-matched-v1",
                            },
                        },
                        "expected_effect": "Structured tool calls are restored.",
                        "risk": "The target restarts.",
                        "verification_plan": ["visible_tool_canary"],
                        "rollback_plan": "Restore captured configuration.",
                    },
                }
            )
        )

        self.assertEqual(
            decision.repair_plan.action.arguments["approved_profile"],
            "qwen-tools-matched-v1",
        )

    def test_incomplete_repair_plan_is_rejected(self) -> None:
        with self.assertRaisesRegex(ContractError, "missing required fields"):
            AgentDecision.from_json(
                json.dumps(
                    {
                        "state": "PLAN",
                        "summary": "Incomplete plan.",
                        "hypotheses": [],
                        "stop_reason": None,
                        "repair_plan": {
                            "hypothesis_id": "parser-contract",
                        },
                    }
                )
            )


if __name__ == "__main__":
    unittest.main()
