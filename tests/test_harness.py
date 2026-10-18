import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from nexus.harness import executor, inspect


def completed(stdout: str = "", stderr: str = "", code: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=stdout, stderr=stderr)


class InspectTests(unittest.TestCase):
    def test_parse_vllm_args_reports_parser_template_and_flag(self):
        fields = inspect.parse_vllm_args([
            "--model", "Qwen/Qwen2.5-Coder-7B-Instruct", "--enable-auto-tool-choice",
            "--tool-call-parser", "hermes", "--revision", "c03e6d3",
        ])
        self.assertEqual(fields["tool_call_parser"], "hermes")
        self.assertEqual(fields["chat_template"], "model default")
        self.assertEqual(fields["model_revision"], "c03e6d3")
        self.assertTrue(fields["enable_auto_tool_choice"])

    def test_redact_removes_tokens(self):
        text = inspect.redact("HF_TOKEN=hf_abcdefghijk Authorization: Bearer xyz.123 api_key=secret")
        self.assertNotIn("hf_abcdefghijk", text)
        self.assertNotIn("xyz.123", text)
        self.assertNotIn("secret", text)

    @mock.patch.object(inspect.manager, "read_state", return_value={"port": 8101})
    def test_unknown_service_is_rejected(self, _state):
        with self.assertRaises(inspect.HarnessError):
            inspect.worker_for("nexus-a")

    @mock.patch.object(inspect.manager, "read_state", return_value={"port": 8103})
    def test_agent_server_is_never_a_target(self, _state):
        with self.assertRaises(inspect.HarnessError):
            inspect.worker_for("target-agent")

    @mock.patch.object(inspect.manager, "read_state", return_value={"port": 8101})
    def test_bounded_logs_validates_arguments(self, _state):
        for kwargs in ({"since": "forever"}, {"limit": 0}, {"limit": 500}, {"pattern": "("}):
            args = {"since": "10m", "pattern": "", "limit": 10, **kwargs}
            with self.assertRaises(inspect.HarnessError):
                inspect.bounded_logs("target-a", **args)

    def test_since_accepts_windows_and_iso_timestamps(self):
        self.assertEqual(inspect.docker_since("10m"), "10m")
        self.assertEqual(inspect.docker_since("2026-10-17T02:51:26+00:00"), "2026-10-17T02:51:26Z")
        self.assertEqual(inspect.docker_since("2026-10-17T22:51:26-04:00"), "2026-10-18T02:51:26Z")
        self.assertEqual(inspect.docker_since("2026-10-17T02:51:26"), "2026-10-17T02:51:26Z")
        with self.assertRaises(inspect.HarnessError):
            inspect.docker_since("yesterday")

    @mock.patch.object(inspect.manager, "read_state", return_value={"port": 8101})
    @mock.patch.object(inspect.subprocess, "run")
    def test_bounded_logs_caps_filters_and_redacts(self, run, _state):
        lines = [f"INFO tool parser line {i} token=abc{i}" for i in range(30)] + ["DEBUG other"]
        run.return_value = completed(stdout="\n".join(lines))
        out = inspect.bounded_logs("target-a", "10m", "tool", 5)
        self.assertEqual(len(out["lines"]), 5)
        self.assertTrue(out["truncated"])
        self.assertEqual(out["matched_lines"], 30)
        self.assertTrue(all("abc" not in line for line in out["lines"]))


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        patches = [
            mock.patch.object(executor, "LOCK_PATH", tmp / "executor.lock"),
            mock.patch.object(executor, "AUDIT_PATH", tmp / "audit.jsonl"),
            mock.patch.object(executor, "worker_for", side_effect=lambda s: s.removeprefix("target-")),
            mock.patch.object(executor, "effective_launch_config", return_value={"tool_call_parser": "hermes"}),
            mock.patch.object(executor, "gateway", return_value={}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_fault_profile_is_rejected(self):
        with mock.patch.object(executor, "other_serving_workers", return_value=["b"]), \
             mock.patch.object(executor.manager, "load_profile", return_value={"kind": "broken"}):
            out = executor.patch_serving_config("target-a", "qwen25-coder-7b.vllm-32926")
        self.assertEqual(out["status"], "REJECTED")

    def test_no_other_serving_worker_requires_approval(self):
        with mock.patch.object(executor, "other_serving_workers", return_value=[]), \
             mock.patch.object(executor.manager, "apply") as apply:
            out = executor.patch_serving_config("target-a", "qwen25-coder-7b.tools-template")
        self.assertEqual(out["status"], "REQUIRES_APPROVAL")
        apply.assert_not_called()

    def test_second_mutation_is_rejected_while_locked(self):
        with executor.mutation_lock():
            out = executor.drain_worker("target-b")
        self.assertEqual(out["status"], "REJECTED")
        self.assertIn("in progress", out["reason"])

    def test_failed_hidden_check_rolls_back(self):
        checks = iter([{"passed": False, "failed_cases": ["hidden_stock"]},
                       {"passed": True, "failed_cases": []}])
        with mock.patch.object(executor, "other_serving_workers", return_value=["b"]), \
             mock.patch.object(executor.manager, "load_profile", return_value={"kind": "healthy"}), \
             mock.patch.object(executor.manager, "apply", return_value={"change_id": "c1"}), \
             mock.patch.object(executor.manager, "rollback") as rollback, \
             mock.patch.object(executor, "hidden_check", side_effect=lambda w: next(checks)):
            out = executor.patch_serving_config("target-a", "qwen25-coder-7b.tools-template")
        self.assertEqual(out["status"], "ROLLED_BACK")
        rollback.assert_called_once_with("a", "c1")

    def test_restart_behind_a_bad_link_is_not_verified(self):
        """Passing on its own port is not enough: the users' path through HAProxy must pass too."""
        bad_route = {"passed": False, "worker": {"p95_s": 1.7, "error_rate": 0.0, "ok": False}}
        with mock.patch.object(executor, "other_serving_workers", return_value=["a"]), \
             mock.patch.object(executor.manager, "read_state", return_value={"port": 8102, "profile": "p"}), \
             mock.patch.object(executor.manager, "load_profile", return_value={"kind": "healthy"}), \
             mock.patch.object(executor.manager, "launch", return_value=70.0), \
             mock.patch.object(executor, "hidden_check", return_value={"passed": True, "failed_cases": []}), \
             mock.patch.object(executor, "route_check", return_value=bad_route):
            out = executor.restart_worker("target-b")
        self.assertEqual(out["status"], "REQUIRES_APPROVAL")
        self.assertIn("HAProxy", out["reason"])
        self.assertEqual(executor.gateway.call_args_list[-1], mock.call("POST", "/admin/workers/b/drain"))

    def test_verified_needs_a_passing_route(self):
        with mock.patch.object(executor, "other_serving_workers", return_value=["b"]), \
             mock.patch.object(executor.manager, "load_profile", return_value={"kind": "healthy"}), \
             mock.patch.object(executor.manager, "apply", return_value={"change_id": "c1"}), \
             mock.patch.object(executor, "hidden_check", return_value={"passed": True, "failed_cases": []}), \
             mock.patch.object(executor, "route_check", return_value={"passed": True}):
            out = executor.patch_serving_config("target-a", "qwen25-coder-7b.tools-template")
        self.assertEqual(out["status"], "VERIFIED")

    @mock.patch.object(executor.manager, "read_state", return_value={"profile": "p"})
    @mock.patch.object(executor.manager, "load_profile", return_value={"served_model_name": "m", "model": "x"})
    def test_route_check_fails_when_no_probe_reaches_the_worker(self, _profile, _state):
        with mock.patch.object(executor.route, "run", return_value={"workers": {"a": {"ok": True}}, "limits": {}}):
            self.assertFalse(executor.route_check("b")["passed"])
            self.assertTrue(executor.route_check("a")["passed"])

    def test_every_action_is_audited(self):
        with mock.patch.object(executor, "other_serving_workers", return_value=["b"]):
            executor.drain_worker("target-a")
            executor.undrain_worker("target-a")
        records = executor.AUDIT_PATH.read_text().splitlines()
        self.assertEqual(len(records), 2)


if __name__ == "__main__":
    unittest.main()
