import unittest

from nexus.agent.contracts import ContractError
from nexus.tools.environment import EnvironmentTools
from nexus.tools.manifest import EnvironmentManifest


class FakeProvider:
    def list_resources(self): return {"resources": [{"id": "api"}]}
    def get_resource_state(self, resource_id, fields): return {"resource_id": resource_id, "values": {key: "ok" for key in fields}}
    def get_configuration(self, resource_id, keys): return {"resource_id": resource_id, "values": {key: "value" for key in keys}}
    def query_logs(self, resource_id, since, query, limit): return {"lines": [], "truncated": False}
    def query_metrics(self, resource_id, metric, window): return {"metric": metric, "value": 1}
    def run_probe(self, probe_id, inputs): return {"observation_id": "obs-1", "passed": True, "inputs": inputs}
    def read_artifact(self, artifact_id, section): return {"artifact_id": artifact_id, "section": section, "content": "data"}


def manifest():
    return EnvironmentManifest.from_dict({
        "id": "general-test", "description": "A non-domain-specific test environment.",
        "resources": [{"id": "api", "kind": "service", "description": "Public API.", "configuration_keys": ["mode"], "metrics": ["error_rate"]}],
        "probes": [{"id": "health-contract", "description": "Check health.", "inputs": {"type": "object", "properties": {"depth": {"type": "integer", "minimum": 1}}, "required": ["depth"], "additionalProperties": False}}],
        "actions": [], "artifact_sections": ["response"],
    })


def context():
    return {"reason": "Test one concrete hypothesis.", "hypothesis_id": "h1", "expected_information_gain": "Separate configuration from runtime failure."}


class EnvironmentToolsTests(unittest.TestCase):
    def setUp(self): self.tools = EnvironmentTools(FakeProvider(), manifest())

    def test_manifest_builds_general_tool_inventory(self):
        names = {item["function"]["name"] for item in self.tools.schemas()}
        self.assertEqual(names, {"describe_environment", "get_configuration", "get_resource_state", "list_resources", "query_logs", "query_metrics", "read_artifact", "run_probe"})
        result = self.tools.invoke("run_probe", {**context(), "probe_id": "health-contract", "inputs": {"depth": 1}})
        self.assertEqual(result.source_type, "probe_result")

    def test_manifest_scopes_resources_metrics_config_and_probe_inputs(self):
        cases = [
            ("get_configuration", {**context(), "resource_id": "api", "keys": ["secret"]}),
            ("query_metrics", {**context(), "resource_id": "api", "metric": "cpu", "window": "5m"}),
            ("run_probe", {**context(), "probe_id": "health-contract", "inputs": {"depth": 0}}),
        ]
        for name, arguments in cases:
            with self.subTest(name=name), self.assertRaises(ContractError): self.tools.invoke(name, arguments)

    def test_unknown_tool_and_unexpected_arguments_are_rejected(self):
        with self.assertRaisesRegex(ContractError, "unknown tool"): self.tools.invoke("shell", context())
        with self.assertRaisesRegex(ContractError, "unexpected arguments"): self.tools.invoke("describe_environment", {**context(), "command": "whoami"})


if __name__ == "__main__":
    unittest.main()
