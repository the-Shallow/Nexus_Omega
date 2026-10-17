import unittest

from nexus.agent.contracts import ContractError, RepairPlan
from nexus.agent.policy import (
    ApprovedServingProfile,
    RepairPolicy,
    RepairPrecheck,
)


class FakeRepairBackend:
    def __init__(self) -> None:
        self.reads = 0

    def get_launch_config(self, service):
        self.reads += 1
        return {
            "service": service,
            "tool_call_parser": "hermes",
            "chat_template": "default",
            "enable_auto_tool_choice": True,
        }


class UnredactedRepairBackend:
    def get_launch_config(self, service):
        return {"service": service, "api_key": "must-not-be-recorded"}


def repair_plan(
    *,
    tool="patch_serving_config",
    arguments=None,
    evidence=None,
):
    return RepairPlan.from_dict(
        {
            "hypothesis_id": "parser-contract",
            "confidence": 0.95,
            "evidence": evidence or ["ev-001", "ev-002"],
            "action": {
                "tool": tool,
                "arguments": arguments
                or {
                    "service": "target-a",
                    "approved_profile": "qwen-tools-matched-v1",
                },
            },
            "expected_effect": "Structured tool calls are parsed successfully.",
            "risk": "The target service requires a bounded restart.",
            "verification_plan": ["readiness", "visible_tool_canary"],
            "rollback_plan": "Restore the captured configuration.",
        }
    )


class RepairPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = FakeRepairBackend()
        self.policy = RepairPolicy(
            allowed_services=("target-a",),
            approved_profiles=(
                ApprovedServingProfile(
                    name="qwen-tools-matched-v1",
                    tool_call_parser="hermes",
                    chat_template="qwen-tools-hermes",
                ),
            ),
        )
        tokens = iter(("001", "rollback-001", "002", "rollback-002"))
        self.precheck = RepairPrecheck(
            self.policy,
            self.backend,
            token_factory=lambda: next(tokens),
        )

    def prepare(self, plan=None):
        return self.precheck.prepare(
            plan or repair_plan(),
            known_evidence={"ev-001", "ev-002", "ev-003"},
            hypothesis_evidence={
                "parser-contract": {"ev-001", "ev-002", "ev-003"}
            },
        )

    def test_approved_matched_profile_captures_before_state_and_rollback(self):
        result = self.prepare()

        self.assertEqual(result.policy.status, "APPROVED")
        self.assertIsNotNone(result.approval)
        self.assertEqual(result.approval.change_id, "chg-001")
        self.assertEqual(result.approval.rollback_token, "rb-rollback-001")
        self.assertEqual(result.approval.before_state["chat_template"], "default")
        self.assertEqual(
            result.approval.profile.chat_template, "qwen-tools-hermes"
        )
        self.assertEqual(self.backend.reads, 1)

    def test_arbitrary_shell_is_rejected_without_reading_state(self):
        result = self.prepare(
            repair_plan(tool="shell", arguments={"command": "docker restart target-a"})
        )

        self.assertEqual(result.policy.status, "REJECTED")
        self.assertIn("not allow-listed", result.policy.reason)
        self.assertEqual(self.backend.reads, 0)

    def test_unapproved_service_requires_human_approval(self):
        result = self.prepare(
            repair_plan(
                arguments={
                    "service": "production-primary",
                    "approved_profile": "qwen-tools-matched-v1",
                }
            )
        )

        self.assertEqual(result.policy.status, "REQUIRES_APPROVAL")
        self.assertEqual(self.backend.reads, 0)

    def test_single_sided_or_path_based_change_is_rejected(self):
        result = self.prepare(
            repair_plan(
                arguments={
                    "service": "target-a",
                    "tool_call_parser": "hermes",
                    "path": "/tmp/template.jinja",
                }
            )
        )

        self.assertEqual(result.policy.status, "REJECTED")
        self.assertIn("single-sided", result.policy.reason)
        self.assertEqual(self.backend.reads, 0)

    def test_second_unverified_repair_is_rejected(self):
        first = self.prepare()
        second = self.prepare()

        self.assertEqual(first.policy.status, "APPROVED")
        self.assertEqual(second.policy.status, "REJECTED")
        self.assertIn("awaiting execution or verification", second.policy.reason)
        self.assertEqual(self.backend.reads, 1)

    def test_unknown_or_unrelated_evidence_is_rejected(self):
        with self.assertRaisesRegex(ContractError, "unknown evidence"):
            self.prepare(repair_plan(evidence=["ev-999"]))

        with self.assertRaisesRegex(ContractError, "not supporting"):
            self.precheck.prepare(
                repair_plan(evidence=["ev-003"]),
                known_evidence={"ev-001", "ev-002", "ev-003"},
                hypothesis_evidence={"parser-contract": {"ev-001", "ev-002"}},
            )

    def test_unredacted_before_state_is_rejected(self):
        precheck = RepairPrecheck(self.policy, UnredactedRepairBackend())
        with self.assertRaisesRegex(ContractError, "must be redacted"):
            precheck.prepare(
                repair_plan(),
                known_evidence={"ev-001", "ev-002"},
                hypothesis_evidence={
                    "parser-contract": {"ev-001", "ev-002"}
                },
            )


if __name__ == "__main__":
    unittest.main()
