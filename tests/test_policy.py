import unittest

from nexus.agent.contracts import ContractError, RepairPlan
from nexus.agent.policy import RepairPolicy, RepairPrecheck
from nexus.tools.manifest import EnvironmentManifest


def manifest(*, automatic=True):
    return EnvironmentManifest.from_dict({
        "id": "test-environment", "description": "Policy test environment.",
        "resources": [{"id": "target-a", "kind": "service", "description": "Test target.", "configuration_keys": ["mode", "template"], "metrics": []}],
        "probes": [],
        "actions": [{
            "id": "set-runtime-profile", "description": "Apply a reviewed profile.",
            "allowed_targets": ["target-a"],
            "parameters": {"type": "object", "properties": {"profile": {"type": "string", "enum": ["matched-v1"]}}, "required": ["profile"], "additionalProperties": False},
            "before_state_keys": ["mode", "template"], "automatic": automatic, "requires_rollback": True,
        }],
    })


class FakeProvider:
    def __init__(self, value=None):
        self.value = value or {"resource_id": "target-a", "mode": "legacy", "template": "default"}
        self.reads = []

    def get_configuration(self, resource_id, keys):
        self.reads.append((resource_id, keys))
        return self.value


def repair_plan(*, tool="apply_action", arguments=None, evidence=None):
    return RepairPlan.from_dict({
        "hypothesis_id": "runtime-contract", "confidence": 0.95,
        "evidence": evidence or ["ev-001", "ev-002"],
        "action": {"tool": tool, "arguments": arguments or {"action_id": "set-runtime-profile", "target": "target-a", "parameters": {"profile": "matched-v1"}}},
        "expected_effect": "The declared probe succeeds.", "risk": "The resource may restart.",
        "verification_plan": ["run the declared verifier"], "rollback_plan": "Restore captured before-state.",
    })


class RepairPolicyTests(unittest.TestCase):
    def setUp(self):
        self.provider = FakeProvider()
        tokens = iter(("001", "rollback-001"))
        self.precheck = RepairPrecheck(RepairPolicy(manifest()), self.provider, token_factory=lambda: next(tokens))

    def prepare(self, plan=None):
        return self.precheck.prepare(
            plan or repair_plan(), known_evidence={"ev-001", "ev-002", "ev-003"},
            hypothesis_evidence={"runtime-contract": {"ev-001", "ev-002", "ev-003"}},
        )

    def test_declared_automatic_action_captures_before_state(self):
        result = self.prepare()
        self.assertEqual(result.policy.status, "APPROVED")
        self.assertEqual(result.approval.change_id, "chg-001")
        self.assertEqual(result.approval.action_id, "set-runtime-profile")
        self.assertEqual(result.approval.parameters, {"profile": "matched-v1"})
        self.assertEqual(self.provider.reads, [("target-a", ["mode", "template"])])

    def test_nonautomatic_action_requires_approval_without_state_read(self):
        provider = FakeProvider()
        precheck = RepairPrecheck(RepairPolicy(manifest(automatic=False)), provider)
        result = precheck.prepare(repair_plan(), known_evidence={"ev-001", "ev-002"}, hypothesis_evidence={"runtime-contract": {"ev-001", "ev-002"}})
        self.assertEqual(result.policy.status, "REQUIRES_APPROVAL")
        self.assertEqual(provider.reads, [])

    def test_undeclared_tool_target_and_parameters_are_rejected(self):
        shell = self.prepare(repair_plan(tool="shell", arguments={"command": "x"}))
        self.assertEqual(shell.policy.status, "REJECTED")
        target = self.prepare(repair_plan(arguments={"action_id": "set-runtime-profile", "target": "other", "parameters": {"profile": "matched-v1"}}))
        self.assertEqual(target.policy.status, "REJECTED")
        parameters = self.prepare(repair_plan(arguments={"action_id": "set-runtime-profile", "target": "target-a", "parameters": {"profile": "invented"}}))
        self.assertEqual(parameters.policy.status, "REJECTED")
        self.assertEqual(self.provider.reads, [])

    def test_active_repair_evidence_and_redaction_guards(self):
        self.assertEqual(self.prepare().policy.status, "APPROVED")
        self.assertEqual(self.prepare().policy.status, "REJECTED")
        with self.assertRaisesRegex(ContractError, "unknown evidence"):
            RepairPrecheck(RepairPolicy(manifest()), FakeProvider()).prepare(repair_plan(evidence=["ev-999"]), known_evidence={"ev-001"}, hypothesis_evidence={"runtime-contract": {"ev-001"}})
        with self.assertRaisesRegex(ContractError, "must be redacted"):
            RepairPrecheck(RepairPolicy(manifest()), FakeProvider({"resource_id": "target-a", "api_key": "secret"})).prepare(repair_plan(), known_evidence={"ev-001", "ev-002"}, hypothesis_evidence={"runtime-contract": {"ev-001", "ev-002"}})


if __name__ == "__main__":
    unittest.main()
