import tempfile
import unittest
from pathlib import Path

from nexus.agent.contracts import ContractError
from nexus.agent.repository import BoundedRepository


class BoundedRepositoryTests(unittest.TestCase):
    def make_repository(self, root: Path) -> BoundedRepository:
        source = root / "nexus"
        source.mkdir()
        (source / "example.py").write_text(
            "def parse_call():\n    parser = 'hermes'\n    return parser\n",
            encoding="utf-8",
        )
        (root / "outside.txt").write_text("secret", encoding="utf-8")
        return BoundedRepository(root, allowed_roots=("nexus",))

    def test_search_returns_numbered_hashed_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = self.make_repository(Path(directory))
            result = repository.search("parser", ["nexus"], 10)

            self.assertEqual(len(result["matches"]), 2)
            self.assertEqual(result["matches"][0]["path"], "nexus/example.py")
            self.assertEqual(result["matches"][0]["line"], 2)
            self.assertEqual(len(result["matches"][0]["sha256"]), 64)

    def test_read_file_is_bounded_and_numbered(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = self.make_repository(Path(directory))
            result = repository.read_file("nexus/example.py", 2, 3)

            self.assertEqual([line["line"] for line in result["lines"]], [2, 3])
            self.assertEqual(result["start_line"], 2)
            self.assertEqual(result["end_line"], 3)

    def test_path_escape_and_non_allowlisted_path_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = self.make_repository(Path(directory))
            with self.assertRaisesRegex(ContractError, "outside the allow-list"):
                repository.read_file("outside.txt", 1, 1)
            with self.assertRaisesRegex(ContractError, "outside the allow-list"):
                repository.read_file("nexus/../../outside.txt", 1, 1)

    def test_more_than_250_lines_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = self.make_repository(Path(directory))
            with self.assertRaisesRegex(ContractError, "at most 250"):
                repository.read_file("nexus/example.py", 1, 251)


if __name__ == "__main__":
    unittest.main()
