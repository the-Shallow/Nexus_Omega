"""Integration checks for pinned source scenarios and their generic provider."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from nexus.evaluation.catalog import IssueCandidateCatalog
from nexus.evaluation.scenario import (
    DiagnosisExpectation,
    ProbeCommand,
    ScenarioDefinition,
)
from nexus.evaluation.verification import verify_diagnosis
from nexus.infrastructure.local_workspace import LocalWorkspaceProvider
from nexus.infrastructure.worktrees import create_isolated_worktree
from nexus.tools.manifest import EnvironmentManifest


ROOT = Path(__file__).resolve().parents[1]


class IssueScenarioTests(unittest.TestCase):
    def test_three_scenarios_match_real_catalog_entries(self):
        catalog = IssueCandidateCatalog.from_csv(ROOT / "data" / "issue-candidates.csv")
        for candidate_id in ("VLLM-55530", "VLLM-59218", "VLLM-56943"):
            with self.subTest(candidate_id=candidate_id):
                scenario = ScenarioDefinition.from_file(
                    ROOT / "scenarios" / "vllm" / candidate_id / "scenario.json"
                )
                candidate = catalog.get(candidate_id)
                self.assertEqual(scenario.candidate_id, candidate.candidate_id)
                self.assertEqual(candidate.reproduction_class, "exact_reproduction")
                self.assertEqual(candidate.execution_mode, "real")
                self.assertFalse(scenario.environment.actions[0].automatic)

    def test_verifier_requires_cited_source_and_expected_location(self):
        scenario = ScenarioDefinition.from_file(
            ROOT / "scenarios" / "vllm" / "VLLM-59218" / "scenario.json"
        )
        action = SimpleNamespace(
            tool="apply_action",
            arguments={
                "action_id": "prepare-source-patch",
                "target": "vllm-source",
                "parameters": {"files": ["vllm/parser/engine/parser_engine.py"]},
            },
        )
        result = SimpleNamespace(
            decision=SimpleNamespace(
                repair_plan=SimpleNamespace(action=action),
                hypotheses=[SimpleNamespace(supports=("ev-001", "ev-002"))],
            ),
            evidence=[SimpleNamespace(evidence_id="ev-002", source_type="source_file")],
            state="REQUIRES_APPROVAL",
        )
        self.assertTrue(verify_diagnosis(scenario, {"reproduced": True}, result).passed)
        action.arguments["parameters"]["files"] = ["vllm/other.py"]
        report = verify_diagnosis(scenario, {"reproduced": True}, result)
        self.assertFalse(report.passed)
        self.assertFalse(report.checks["expected_location"])

    def test_pinned_worktree_runs_only_declared_probe_and_records_artifacts(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            repository = root / "repo"
            repository.mkdir()
            self._git(repository, "init")
            self._git(repository, "-c", "user.name=Nexus Test", "-c", "user.email=nexus@example.test", "commit", "--allow-empty", "-m", "fixture")
            revision = self._git(repository, "rev-parse", "HEAD")
            workspace = root / "run" / "workspace"
            self.assertEqual(create_isolated_worktree(repository, workspace, revision), revision)
            manifest = EnvironmentManifest.from_dict(
                {
                    "id": "fixture",
                    "description": "Local provider integration fixture",
                    "resources": [
                        {
                            "id": "source",
                            "kind": "source-repository",
                            "description": "Pinned checkout",
                            "configuration_keys": ["revision"],
                        }
                    ],
                    "probes": [
                        {
                            "id": "observe",
                            "description": "Write a structured observation",
                            "inputs": {"type": "object", "properties": {}},
                        }
                    ],
                    "artifact_sections": ["result", "stdout", "stderr"],
                }
            )
            scenario = ScenarioDefinition(
                "fixture", "fixture", "local", revision, ("src",), manifest,
                {
                    "observe": ProbeCommand(
                        "observe",
                        (
                            "{python}",
                            "-c",
                            "import json,os,pathlib; pathlib.Path(os.environ['NEXUS_PROBE_RESULT_PATH']).write_text(json.dumps({'reproduced': True})); print('fixture observation')",
                        ),
                        10,
                    )
                },
                expectation=DiagnosisExpectation("fixture", "source", ("src/file.py",)),
            )
            provider = LocalWorkspaceProvider(
                workspace, scenario, root / "run" / "probes", ROOT,
                python_executable=sys.executable,
            )
            result = provider.run_probe("observe", {})
            self.assertTrue(result["reproduced"])
            self.assertEqual(result["exit_code"], 0)
            self.assertIn("fixture observation", provider.read_artifact(result["artifact_id"], "stdout")["content"])
            self.assertEqual(provider.get_configuration("source", ["revision"])["configuration"]["revision"], revision)

    @staticmethod
    def _git(repository: Path, *arguments: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(repository), *arguments],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()


if __name__ == "__main__":
    unittest.main()
