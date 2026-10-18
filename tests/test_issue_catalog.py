import tempfile
import unittest
from pathlib import Path

from nexus.evaluation.catalog import CandidateCatalogError, IssueCandidateCatalog


class IssueCandidateCatalogTests(unittest.TestCase):
    def test_canonical_catalog_loads_real_candidates(self):
        catalog = IssueCandidateCatalog.from_csv(Path("data/issue-candidates.csv"))

        candidate = catalog.get("VLLM-55530")
        self.assertEqual(candidate.incident_class, "Serving-code defects")
        self.assertEqual(candidate.reproduction_class, "exact_reproduction")
        self.assertEqual(candidate.execution_mode, "real")
        self.assertTrue(candidate.upstream_url.startswith("https://github.com/"))

        cpu_exact = catalog.select(
            reproduction_class="exact_reproduction", execution_mode="real"
        )
        self.assertIn("VLLM-59218", {item.candidate_id for item in cpu_exact})

    def test_unknown_candidate_is_rejected(self):
        catalog = IssueCandidateCatalog.from_csv(Path("data/issue-candidates.csv"))
        with self.assertRaisesRegex(CandidateCatalogError, "unknown issue candidate"):
            catalog.get("NOT-REAL")

    def test_catalog_schema_is_strict(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.csv"
            path.write_text("candidate_id,incident_class\nX,Capacity\n", encoding="utf-8")
            with self.assertRaisesRegex(CandidateCatalogError, "columns"):
                IssueCandidateCatalog.from_csv(path)


if __name__ == "__main__":
    unittest.main()
