import os
import unittest
from unittest import mock

os.environ["NEXUS_ENVIRONMENT_API_KEY"] = "read-key"
os.environ["NEXUS_EXECUTOR_TOKEN"] = "exec-key"

from fastapi.testclient import TestClient  # noqa: E402

from apps.environment import main  # noqa: E402
from nexus.tools.manifest import EnvironmentManifest  # noqa: E402

READ = {"Authorization": "Bearer read-key"}
EXEC = {"Authorization": "Bearer exec-key"}


class EnvironmentApiTests(unittest.TestCase):
    def setUp(self):
        main.API_KEY, main.EXECUTOR_TOKEN = "read-key", "exec-key"
        self.client = TestClient(main.app)

    def test_manifest_parses_with_the_agent_contract(self):
        manifest = EnvironmentManifest.from_dict(self.client.get("/environment", headers=READ).json())
        self.assertEqual(set(manifest.resource_map), {"target-a", "target-b"})
        self.assertIn("route_latency_avg_s", manifest.resource_map["target-b"].metrics)
        profiles = manifest.action_map["apply-serving-profile"].parameters["properties"]["profile"]["enum"]
        self.assertIn("qwen25-coder-7b.tools-template", profiles)
        self.assertNotIn("qwen25-coder-7b.vllm-32926", profiles)
        self.assertFalse(manifest.action_map["undrain-worker"].automatic)
        # A worker's current profile name would reveal the injected fault.
        self.assertNotIn("profile_label", manifest.resource_map["target-a"].configuration_keys)

    def test_read_routes_need_the_read_key(self):
        self.assertEqual(self.client.get("/environment").status_code, 401)
        self.assertEqual(self.client.get("/environment", headers=EXEC).status_code, 401)

    def test_apply_needs_the_executor_key_not_the_read_key(self):
        body = {"target": "target-a", "parameters": {}}
        self.assertEqual(self.client.post("/actions/drain-worker/apply", json=body, headers=READ).status_code, 401)

    def test_undeclared_things_are_rejected(self):
        self.assertEqual(self.client.post("/resources/target-agent/state", json={"fields": ["ready"]},
                                          headers=READ).status_code, 404)
        self.assertEqual(self.client.post("/probes/shell/run", json={"inputs": {}}, headers=READ).status_code, 404)
        self.assertEqual(self.client.post("/metrics/query", json={"resource_id": "target-a", "metric": "cpu",
                                                                  "window": "1m"}, headers=READ).status_code, 404)
        self.assertEqual(self.client.post("/artifacts/read", json={"artifact_id": "x", "section": "env"},
                                          headers=READ).status_code, 404)

    def test_unknown_config_keys_are_named_not_fatal(self):
        with mock.patch.object(main, "effective_launch_config",
                               return_value={"source": "docker inspect", "tool_call_parser": "hermes", "environment": "x"}):
            resp = self.client.post("/resources/target-a/configuration", headers=READ,
                                    json={"keys": ["tool_call_parser", "environment"]})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["configuration"], {"tool_call_parser": "hermes"})
        self.assertEqual(resp.json()["unavailable_keys"], ["environment"])

    def test_apply_rejects_unapproved_profile(self):
        with mock.patch.object(main.executor, "patch_serving_config") as patch:
            resp = self.client.post("/actions/apply-serving-profile/apply", headers=EXEC,
                                    json={"target": "target-a", "parameters": {"profile": "qwen25-coder-7b.vllm-32926"}})
        self.assertEqual(resp.status_code, 403)
        patch.assert_not_called()

    def test_apply_routes_to_the_executor(self):
        with mock.patch.object(main.executor, "patch_serving_config", return_value={"status": "VERIFIED"}) as patch:
            resp = self.client.post("/actions/apply-serving-profile/apply", headers=EXEC, json={
                "target": "target-a", "parameters": {"profile": "qwen25-coder-7b.tools-template"}, "change_id": "chg-1"})
        self.assertEqual(resp.json()["executor"]["status"], "VERIFIED")
        patch.assert_called_once_with("target-a", "qwen25-coder-7b.tools-template")

    def test_visible_probe_returns_an_artifact_for_trace_and_raw(self):
        canary_result = {"http_status": 200, "content": "```json {\"name\": \"get_weather\"}```", "tool_calls": [],
                         "latency_s": 0.5, "reason": "no structured tool_calls in response",
                         "raw_generation": {"available": True, "text": "```json {\"name\": \"get_weather\"}```"}}
        with mock.patch.object(main.manager, "read_state", return_value={"port": 8101, "profile": "p"}), \
             mock.patch.object(main.manager, "load_profile", return_value={"served_model_name": "qwen25-coder"}), \
             mock.patch.object(main.canary, "run_case", return_value=canary_result):
            probe = self.client.post("/probes/tool-call-visible/run", headers=READ,
                                     json={"inputs": {"case": "visible_tool_call", "resource_id": "target-a"}}).json()
        self.assertEqual(probe["structured_tool_call_count"], 0)
        raw = self.client.post("/artifacts/read", headers=READ,
                               json={"artifact_id": probe["artifact_id"], "section": "raw_generation"}).json()
        self.assertIn("get_weather", raw["content"]["text"])
        self.assertEqual(raw["content"]["capture"], "deterministic_replay")


if __name__ == "__main__":
    unittest.main()
