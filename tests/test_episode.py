import json
import unittest
from pathlib import Path

from nexus.baseline import rules
from nexus.eval import episode
from nexus.harness import inspect

PROFILES = Path(__file__).resolve().parents[1] / "runtime" / "profiles"


def check(users_ok=True, root=None, drained=None) -> dict:
    root, drained = root or {}, drained or {}
    return {"users_ok": users_ok, "root_fixed": all(root.values()), "root": root,
            "faulty_worker_drained": all(drained.values()), "drained": drained}


def round_(state: str, tool: str | None = None, worker: str = "a") -> dict:
    return {"state": state, "action": {"tool": tool, "service": f"target-{worker}"} if tool else {}}


class FaultSpecTests(unittest.TestCase):
    def test_known_faults_keep_their_targets(self):
        self.assertEqual(episode.KNOWN, ["vllm-32926", "net-latency-b", "net-blackhole-b", "kill-b"])
        self.assertEqual(episode.FAULTS["vllm-32926"].get("fix"), ["a"])
        self.assertEqual(episode.FAULTS["kill-b"].get("fix"), ["b"])
        for name in ("net-latency-b", "net-blackhole-b"):
            self.assertEqual(episode.FAULTS[name].get("drain"), ["b"])
            self.assertIsNone(episode.FAULTS[name].get("fix"))
        for name in episode.KNOWN:
            self.assertEqual(episode.FAULTS[name].get("rounds", 1), 1)

    def test_heldout_profiles_exist_and_are_not_approved_repairs(self):
        self.assertEqual(set(episode.HELDOUT), {"compound-latb-32926a", "capacity-b", "tools-stripped-a", "noop"})
        for name in ("qwen25-coder-7b.tools-stripped", "qwen25-coder-7b.capacity-1seq"):
            profile = json.loads((PROFILES / f"{name}.json").read_text())
            self.assertEqual(profile["kind"], "broken")
            self.assertNotIn("stripped", profile["chat_template"])  # file name must not name the fault


class ScoreTests(unittest.TestCase):
    def test_fixable_fault_unchanged(self):
        fault = episode.FAULTS["vllm-32926"]
        self.assertEqual(episode.score(fault, check(root={"a": True}), [round_("VERIFIED", "patch")]),
                         ("VERIFIED", True, False))
        self.assertEqual(episode.score(fault, check(root={"a": False}), [round_("VERIFIED", "patch", "b")]),
                         ("VERIFIED", False, True))

    def test_link_fault_needs_drain_and_open_incident(self):
        fault = episode.FAULTS["net-latency-b"]
        drained = check(drained={"b": True})
        self.assertEqual(episode.score(fault, drained, [round_("REQUIRES_APPROVAL", "drain", "b")]),
                         ("REQUIRES_APPROVAL", True, False))
        # Claiming the link is fixed is a false VERIFIED even when users are served.
        self.assertEqual(episode.score(fault, drained, [round_("VERIFIED", "restart", "b")]),
                         ("VERIFIED", False, True))

    def test_compound_fix_then_drain_succeeds(self):
        fault = episode.FAULTS["compound-latb-32926a"]
        done = check(root={"a": True}, drained={"b": True})
        rounds = [round_("VERIFIED", "patch", "a"), round_("REQUIRES_APPROVAL", "drain", "b")]
        self.assertEqual(episode.score(fault, done, rounds), ("REQUIRES_APPROVAL", True, False))

    def test_compound_fix_only_is_a_false_close(self):
        fault = episode.FAULTS["compound-latb-32926a"]
        half = check(users_ok=False, root={"a": True}, drained={"b": False})
        self.assertEqual(episode.score(fault, half, [round_("VERIFIED", "patch", "a"), round_("ABSTAIN")]),
                         ("VERIFIED", False, True))

    def test_noop_any_action_fails(self):
        fault = episode.FAULTS["noop"]
        self.assertEqual(episode.score(fault, check(), [round_("ABSTAIN")]), ("ABSTAIN", True, False))
        self.assertFalse(episode.score(fault, check(), [round_("REQUIRES_APPROVAL", "drain", "b")])[1])


class HeldoutSymptomTests(unittest.TestCase):
    def test_rules_miss_prose_only_answer(self):
        canary = {"ok": False, "http_status": 200, "tool_calls": [],
                  "content": "I don't have access to real-time weather data, but you can check a weather site."}
        obs = {"workers": {"a": {"container": "running", "profile": "qwen25-coder-7b.tools-stripped",
                                 "canary": canary, "direct": {"status": 200, "latency_s": 0.1}}},
               "routes": {"a": {"ok": True}}}
        self.assertEqual(rules.decide(obs)[0], "no_match")

    def test_max_num_seqs_is_visible(self):
        fields = inspect.parse_vllm_args(["--max-num-seqs", "1"])
        self.assertEqual(fields["max_num_seqs"], "1")
        self.assertEqual(inspect.parse_vllm_args([])["max_num_seqs"], "vllm default")


if __name__ == "__main__":
    unittest.main()
