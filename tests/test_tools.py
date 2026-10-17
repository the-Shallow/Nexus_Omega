import unittest

from nexus.agent.contracts import ContractError
from nexus.agent.tools import build_checkpoint_zero_registry


class ToolRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = build_checkpoint_zero_registry()

    def test_get_topology_is_read_only_and_deterministic(self) -> None:
        result = self.registry.invoke("get_topology", {})
        self.assertEqual(result["controller"]["status"], "ready")
        self.assertEqual(result["services"], [])

    def test_unknown_tool_is_rejected(self) -> None:
        with self.assertRaisesRegex(ContractError, "unknown tool"):
            self.registry.invoke("shell", {})

    def test_unexpected_argument_is_rejected(self) -> None:
        with self.assertRaisesRegex(ContractError, "unexpected arguments"):
            self.registry.invoke("get_topology", {"command": "whoami"})


if __name__ == "__main__":
    unittest.main()
