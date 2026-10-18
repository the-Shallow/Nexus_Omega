import json
import unittest

from nexus.agent.contracts import (
    AgentDecision,
    ContractError,
    DiagnosticInput,
    ModelTurn,
)


class ContractTests(unittest.TestCase):
    def test_structured_diagnostic_input_is_decoded(self) -> None:
        diagnostic_input = DiagnosticInput.from_dict(
            {
                "trigger_id": "trigger-1",
                "summary": "A worker emitted repeated allocation failures.",
                "observed_at": "2026-10-17T14:22:31Z",
                "affected_resources": ["worker-1"],
                "initial_observations": [
                    {
                        "source_type": "log",
                        "source": "worker-1:stderr",
                        "finding": "CUDA allocation failed.",
                        "content": {"lines": ["CUDA out of memory"]},
                        "trust": "untrusted",
                        "resource_id": "worker-1",
                    }
                ],
                "correlation_ids": {"request_id": "req-1"},
            }
        )
        self.assertEqual(diagnostic_input.affected_resources, ("worker-1",))
        self.assertEqual(
            diagnostic_input.initial_observations[0].trust, "untrusted"
        )

    def test_diagnostic_input_requires_timestamp_and_valid_trust(self) -> None:
        payload = {
            "trigger_id": "trigger-1",
            "summary": "Failure detected.",
            "observed_at": "2026-10-17T14:22:31",
            "affected_resources": [],
            "initial_observations": [],
        }
        with self.assertRaisesRegex(ContractError, "include a timezone"):
            DiagnosticInput.from_dict(payload)

        payload["observed_at"] = "2026-10-17T14:22:31Z"
        payload["initial_observations"] = [
            {
                "source_type": "log",
                "source": "stderr",
                "finding": "Failure detected.",
                "content": {},
                "trust": "maybe",
            }
        ]
        with self.assertRaisesRegex(ContractError, "trusted or untrusted"):
            DiagnosticInput.from_dict(payload)

    def test_native_tool_call_is_decoded(self) -> None:
        turn = ModelTurn.from_vllm_message(
            {
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "describe_environment", "arguments": "{}"},
                    }
                ],
            }
        )
        self.assertEqual(turn.tool_calls[0].name, "describe_environment")
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
                                "name": "describe_environment",
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
                            "tool": "apply_action",
                            "arguments": {
                                "action_id": "apply-serving-profile",
                                "target": "target-a",
                                "parameters": {
                                    "profile": "qwen-tools-matched-v1"
                                },
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
            decision.repair_plan.action.arguments["parameters"]["profile"],
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
