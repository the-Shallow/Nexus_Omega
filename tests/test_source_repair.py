"""Source proposal and worktree execution checks."""

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from nexus.agent.contracts import ModelTurn
from nexus.agent.contracts import ToolCall
from nexus.agent.evidence import EvidenceLedger
from nexus.evaluation.source_repair import (
    IsolatedSourceExecutor,
    SourceEdit,
    SourcePatchPlanner,
    SourcePatchProposal,
    SourceRepairError,
)
from nexus.infrastructure.nemotron import ScriptedNemotronClient
from nexus.infrastructure.repository import BoundedRepository
from nexus.infrastructure.worktrees import create_isolated_worktree
from scripts import run_issue_scenarios


ROOT = Path(__file__).resolve().parents[1]


class SourceRepairTests(unittest.TestCase):
    def test_runner_completes_opt_in_repair_with_real_probe(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            repository, _, revision = self._worktree(root)
            nexus_root = root / "nexus-fixture"
            (nexus_root / "data").mkdir(parents=True)
            shutil.copyfile(
                ROOT / "data" / "issue-candidates.csv",
                nexus_root / "data" / "issue-candidates.csv",
            )
            scenario_dir = nexus_root / "scenarios" / "vllm" / "VLLM-59218"
            scenario_dir.mkdir(parents=True)
            probe_code = (
                "import json,os,pathlib; "
                "fixed='return True' in pathlib.Path('src/module.py').read_text(); "
                "pathlib.Path(os.environ['NEXUS_PROBE_RESULT_PATH']).write_text("
                "json.dumps({'reproduced':not fixed,'passed':fixed,'summary':'Fixture regression'}))"
            )
            scenario = {
                "id": "fixture-source-repair",
                "candidate_id": "VLLM-59218",
                "repository": "local fixture",
                "revision": revision,
                "allowed_roots": ["src"],
                "environment": {
                    "id": "fixture",
                    "description": "Fixture source diagnosis",
                    "resources": [{
                        "id": "vllm-source", "kind": "source-repository",
                        "description": "Fixture checkout",
                        "configuration_keys": ["revision", "dirty"], "metrics": [],
                    }],
                    "probes": [{
                        "id": "reproduce", "description": "Fixture regression",
                        "inputs": {"type": "object", "properties": {}, "additionalProperties": False},
                    }],
                    "actions": [{
                        "id": "prepare-source-patch", "description": "Reviewed source edit",
                        "allowed_targets": ["vllm-source"],
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "files": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                                "test_strategy": {"type": "string", "enum": ["focused-regression"]},
                            },
                            "required": ["files", "test_strategy"],
                            "additionalProperties": False,
                        },
                        "before_state_keys": ["revision", "dirty"],
                        "automatic": False,
                        "requires_rollback": True,
                    }],
                    "artifact_sections": ["result", "stdout", "stderr"],
                    "verifiers": ["diagnosis-contract"],
                },
                "probe_commands": {
                    "reproduce": {
                        "argv": ["{python}", "-c", probe_code],
                        "timeout_seconds": 10,
                    }
                },
                "diagnosis_expectation": {
                    "action_id": "prepare-source-patch", "target": "vllm-source",
                    "expected_paths": ["src/module.py"],
                    "require_initial_evidence": True,
                    "require_source_evidence": True,
                },
            }
            (scenario_dir / "scenario.json").write_text(
                json.dumps(scenario), encoding="utf-8"
            )
            context = {
                "reason": "Inspect the observed source path.",
                "hypothesis_id": "fixture",
                "expected_information_gain": "Locate the wrong return value.",
            }
            decision = {
                "state": "PLAN",
                "summary": "The function returns the wrong value.",
                "hypotheses": [{
                    "id": "fixture", "confidence": 0.9,
                    "supports": ["ev-001", "ev-002"], "contradicts": [],
                }],
                "stop_reason": None,
                "repair_plan": {
                    "hypothesis_id": "fixture", "confidence": 0.9,
                    "evidence": ["ev-001", "ev-002"],
                    "action": {
                        "tool": "apply_action",
                        "arguments": {
                            "action_id": "prepare-source-patch",
                            "target": "vllm-source",
                            "parameters": {
                                "files": ["src/module.py"],
                                "test_strategy": "focused-regression",
                            },
                        },
                    },
                    "expected_effect": "The fixture probe passes.",
                    "risk": "The edit may be wrong.",
                    "verification_plan": ["Rerun reproduce"],
                    "rollback_plan": "Restore the original file.",
                },
            }
            turns = [
                ModelTurn(tool_calls=(ToolCall(
                    "read-1", "read_file",
                    {**context, "path": "src/module.py", "start_line": 1, "end_line": 2},
                ),)),
                ModelTurn(content=json.dumps(decision)),
                ModelTurn(content=json.dumps({
                    "rationale": "Use the expected return value.",
                    "edits": [{
                        "path": "src/module.py",
                        "old_text": "return False",
                        "new_text": "return True",
                    }],
                })),
            ]
            client = ScriptedNemotronClient(turns)
            with patch.object(run_issue_scenarios, "ROOT", nexus_root), patch.object(
                run_issue_scenarios, "VLLMNemotronClient", return_value=client
            ), patch.object(
                run_issue_scenarios.VLLMClientConfig, "from_env", return_value=None
            ):
                passed = run_issue_scenarios.run_scenario(
                    "VLLM-59218", repository, root / "artifacts", execute_repair=True
                )
            run_root = next((root / "artifacts").iterdir())
            if not passed:
                self.fail((run_root / "error.json").read_text(encoding="utf-8"))
            recovery = json.loads((run_root / "recovery.json").read_text())
            self.assertEqual(recovery["state"], "VERIFIED")
            self.assertTrue(json.loads((run_root / "post-repair-verification.json").read_text())["passed"])
            self.assertIn(
                "return True", (run_root / "workspace" / "src" / "module.py").read_text()
            )
            scenario["probe_commands"]["reproduce"]["argv"][2] = (
                "import json,os,pathlib; "
                "pathlib.Path(os.environ['NEXUS_PROBE_RESULT_PATH']).write_text("
                "json.dumps({'reproduced':True,'passed':False,'summary':'Fixture regression'}))"
            )
            (scenario_dir / "scenario.json").write_text(
                json.dumps(scenario), encoding="utf-8"
            )
            with patch.object(run_issue_scenarios, "ROOT", nexus_root), patch.object(
                run_issue_scenarios,
                "VLLMNemotronClient",
                return_value=ScriptedNemotronClient(turns),
            ), patch.object(
                run_issue_scenarios.VLLMClientConfig, "from_env", return_value=None
            ):
                passed = run_issue_scenarios.run_scenario(
                    "VLLM-59218", repository, root / "artifacts", execute_repair=True
                )
            self.assertFalse(passed)
            rollback_root = next(
                path for path in (root / "artifacts").iterdir() if path != run_root
            )
            rollback = json.loads((rollback_root / "recovery.json").read_text())
            self.assertEqual(rollback["state"], "ROLLED_BACK")
            self.assertTrue(rollback["rollback_reproduced"])
            self.assertEqual(
                self._git(rollback_root / "workspace", "status", "--porcelain"), ""
            )

    def test_cited_source_proposal_applies_and_rolls_back(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            repository, workspace, revision = self._worktree(Path(directory))
            del repository
            source = workspace / "src" / "module.py"
            ledger = EvidenceLedger(Path(directory) / "audit")
            content = BoundedRepository(workspace, allowed_roots=("src",)).read_file(
                "src/module.py", 1, 5
            )
            record = ledger.add(
                source_type="source_file",
                source="file:src/module.py:1-5",
                finding="Read source",
                content=content,
                trust="untrusted",
            )
            client = ScriptedNemotronClient(
                [
                    ModelTurn(
                        content=json.dumps(
                            {
                                "rationale": "Return the expected value.",
                                "edits": [
                                    {
                                        "path": "src/module.py",
                                        "old_text": "return False",
                                        "new_text": "return True",
                                    }
                                ],
                            }
                        )
                    )
                ]
            )
            result = SimpleNamespace(
                evidence=(record,),
                decision=SimpleNamespace(
                    hypotheses=(SimpleNamespace(supports=(record.evidence_id,)),),
                    to_dict=lambda: {"summary": "Observed wrong result"},
                ),
            )
            proposal = SourcePatchPlanner(client, ledger).propose(
                result, ("src/module.py",)
            )
            executor = IsolatedSourceExecutor(workspace, ("src",))
            diff = executor.apply(proposal, revision)
            self.assertIn("+    return True", diff)
            self.assertIn("return True", source.read_text(encoding="utf-8"))
            executor.rollback()
            self.assertIn("return False", source.read_text(encoding="utf-8"))
            self.assertEqual(self._git(workspace, "status", "--porcelain"), "")

    def test_rejects_stale_content_and_path_escape_before_writing(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            _, workspace, revision = self._worktree(Path(directory))
            source = workspace / "src" / "module.py"
            before = source.read_bytes()
            executor = IsolatedSourceExecutor(workspace, ("src",))
            stale = SourcePatchProposal(
                (SourceEdit("src/module.py", "return False", "return True", "0" * 64),),
                "test",
            )
            with self.assertRaisesRegex(SourceRepairError, "changed since it was read"):
                executor.apply(stale, revision)
            escape = SourcePatchProposal(
                (SourceEdit("../outside.py", "return False", "return True", hashlib.sha256(before).hexdigest()),),
                "test",
            )
            with self.assertRaisesRegex(SourceRepairError, "not an allowed Python file"):
                executor.apply(escape, revision)
            self.assertEqual(source.read_bytes(), before)

    @staticmethod
    def _worktree(root: Path) -> tuple[Path, Path, str]:
        repository = root / "repo"
        (repository / "src").mkdir(parents=True)
        (repository / "src" / "module.py").write_text(
            "def check():\n    return False\n", encoding="utf-8"
        )
        SourceRepairTests._git(repository, "init")
        SourceRepairTests._git(repository, "add", "src/module.py")
        SourceRepairTests._git(
            repository,
            "-c", "user.name=Nexus Test",
            "-c", "user.email=nexus@example.test",
            "commit", "-m", "fixture",
        )
        revision = SourceRepairTests._git(repository, "rev-parse", "HEAD")
        workspace = root / "run" / "workspace"
        create_isolated_worktree(repository, workspace, revision)
        return repository, workspace, revision

    @staticmethod
    def _git(repository: Path, *arguments: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(repository), *arguments],
            capture_output=True,
            text=True,
            check=True,
        )
        return completed.stdout.strip()


if __name__ == "__main__":
    unittest.main()
