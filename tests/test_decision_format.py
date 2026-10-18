import json
import tempfile
import unittest
from pathlib import Path

from nexus.agent.contracts import ContractError, ModelTurn, ToolCall
from nexus.agent.decision_format import decision_response_format
from nexus.agent.tool_loop import ToolLoopController
from nexus.infrastructure.events import JsonlEventLog
from nexus.infrastructure.nemotron import ScriptedNemotronClient, VLLMClientConfig, VLLMNemotronClient
from nexus.tools.registry import ToolDefinition, ToolRegistry

DESCRIBE = ModelTurn(tool_calls=(ToolCall("call-1", "describe_environment", {}),))
# The shape Lightning returned live: hypotheses as plain strings.
STRING_HYPOTHESES = ModelTurn(content=json.dumps({
    "state": "DIAGNOSE", "summary": "Capabilities collected.",
    "hypotheses": ["environment is minimal"], "stop_reason": None,
}))
VALID = ModelTurn(content=json.dumps({
    "state": "DIAGNOSE", "summary": "Capabilities collected.",
    "hypotheses": [{"id": "minimal-env", "confidence": 0.4, "supports": [], "contradicts": []}],
    "stop_reason": None,
}))


def registry():
    return ToolRegistry([ToolDefinition(
        "describe_environment", "Describe capabilities.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        lambda args: {"id": "test", "resources": []})])


def run(client, directory):
    path = Path(directory) / "events.jsonl"
    result = ToolLoopController(run_id="run", client=client, tools=registry(),
                                event_log=JsonlEventLog(path, "run")).run("Inspect capabilities.")
    events = [json.loads(line)["event_type"] for line in path.read_text().splitlines()]
    return result, events


class DecisionFormatTests(unittest.TestCase):
    def test_invalid_answer_is_retried_under_the_schema(self):
        client = ScriptedNemotronClient([DESCRIBE, STRING_HYPOTHESES, VALID])
        with tempfile.TemporaryDirectory() as directory:
            result, events = run(client, directory)
        self.assertEqual(result.decision.hypotheses[0].hypothesis_id, "minimal-env")
        self.assertEqual(result.steps, 3)
        retry = client.requests[-1]
        self.assertEqual(retry["tools"], [])
        self.assertEqual(retry["response_format"], decision_response_format())
        self.assertIn("decision_reformat_requested", events)
        self.assertIn("decision_reformatted", events)

    def test_valid_answer_is_not_retried(self):
        client = ScriptedNemotronClient([DESCRIBE, VALID])
        with tempfile.TemporaryDirectory() as directory:
            result, events = run(client, directory)
        self.assertEqual(len(client.requests), 2)
        self.assertIsNone(client.requests[-1]["response_format"])
        self.assertNotIn("decision_reformat_requested", events)

    def test_second_invalid_answer_still_fails(self):
        client = ScriptedNemotronClient([DESCRIBE, STRING_HYPOTHESES, STRING_HYPOTHESES])
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ContractError):
            run(client, directory)

    def test_payload_never_mixes_tools_and_response_format(self):
        client = VLLMNemotronClient(VLLMClientConfig(base_url="http://unused/v1", model="m"))
        tool_turn = client.build_payload([], [{"type": "function"}])
        self.assertEqual(tool_turn["tool_choice"], "auto")
        self.assertNotIn("response_format", tool_turn)
        final_turn = client.build_payload([], [], decision_response_format())
        self.assertNotIn("tools", final_turn)
        self.assertNotIn("tool_choice", final_turn)
        self.assertEqual(final_turn["response_format"]["type"], "json_schema")
        self.assertEqual(final_turn["max_tokens"], 1024)
        self.assertNotIn("max_tokens", tool_turn)
        self.assertEqual(final_turn["chat_template_kwargs"], {"enable_thinking": False})
        self.assertNotIn("chat_template_kwargs", tool_turn)

    def test_response_format_uses_the_canonical_schema(self):
        schema = decision_response_format()["json_schema"]["schema"]
        self.assertNotIn("$schema", schema)
        self.assertEqual(schema["required"], ["state", "summary", "hypotheses", "stop_reason"])
        self.assertEqual(schema["properties"]["hypotheses"]["items"]["required"],
                         ["id", "confidence", "supports", "contradicts"])


if __name__ == "__main__":
    unittest.main()
