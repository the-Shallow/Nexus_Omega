"""Local, manifest-constrained environment provider for source diagnostics."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..agent.contracts import ContractError
if TYPE_CHECKING:
    from ..evaluation.scenario import ScenarioDefinition


class LocalWorkspaceProvider:
    """Expose generic observations while executing only trusted probe commands."""

    def __init__(
        self,
        workspace: Path,
        scenario: "ScenarioDefinition",
        artifact_root: Path,
        nexus_root: Path,
        *,
        python_executable: str = sys.executable,
        max_artifact_bytes: int = 200_000,
    ) -> None:
        self.workspace = Path(workspace).resolve()
        self.scenario = scenario
        self.artifact_root = Path(artifact_root).resolve()
        self.nexus_root = Path(nexus_root).resolve()
        self.python_executable = python_executable
        self.max_artifact_bytes = max_artifact_bytes
        if not self.workspace.is_dir():
            raise ContractError(f"workspace does not exist: {self.workspace}")
        self.artifact_root.mkdir(parents=True, exist_ok=True)
        self._artifacts: dict[str, Path] = {}
        self._probe_counts: dict[str, int] = {}

    def describe_environment(self) -> dict[str, Any]:
        return self.scenario.environment.to_dict()

    def list_resources(self) -> dict[str, Any]:
        return {
            "resources": [
                {
                    "id": resource.resource_id,
                    "kind": resource.kind,
                    "description": resource.description,
                    "available": True,
                }
                for resource in self.scenario.environment.resources
            ]
        }

    def get_resource_state(
        self, resource_id: str, fields: list[str]
    ) -> dict[str, Any]:
        self._resource(resource_id)
        values = self._workspace_values()
        return {
            "resource_id": resource_id,
            "state": {field: values[field] for field in fields if field in values},
            "unsupported_fields": [field for field in fields if field not in values],
        }

    def get_configuration(
        self, resource_id: str, keys: list[str]
    ) -> dict[str, Any]:
        resource = self._resource(resource_id)
        unknown = set(keys) - set(resource.configuration_keys)
        if unknown:
            raise ContractError(
                f"configuration keys are not declared for {resource_id}: {sorted(unknown)}"
            )
        values = self._workspace_values()
        return {
            "resource_id": resource_id,
            "configuration": {key: values[key] for key in keys},
        }

    def query_logs(
        self, resource_id: str, since: str, query: str, limit: int
    ) -> dict[str, Any]:
        self._resource(resource_id)
        del since
        lines: list[dict[str, Any]] = []
        for artifact_id, directory in reversed(tuple(self._artifacts.items())):
            for section in ("stdout", "stderr"):
                path = directory / f"{section}.log"
                if not path.is_file():
                    continue
                for line_number, line in enumerate(
                    path.read_text(encoding="utf-8", errors="replace").splitlines(),
                    start=1,
                ):
                    if query and query not in line:
                        continue
                    lines.append(
                        {
                            "artifact_id": artifact_id,
                            "section": section,
                            "line": line_number,
                            "text": line,
                        }
                    )
                    if len(lines) >= limit:
                        return {"lines": lines, "truncated": True}
        return {"lines": lines, "truncated": False}

    def query_metrics(
        self, resource_id: str, metric: str, window: str
    ) -> dict[str, Any]:
        del metric, window
        self._resource(resource_id)
        raise ContractError("this local source environment declares no metrics")

    def run_probe(self, probe_id: str, inputs: dict[str, Any]) -> dict[str, Any]:
        try:
            command = self.scenario.probe_commands[probe_id]
        except KeyError as exc:
            raise ContractError(f"probe is not declared: {probe_id}") from exc
        count = self._probe_counts.get(probe_id, 0) + 1
        self._probe_counts[probe_id] = count
        artifact_id = f"probe-{probe_id}-{count:03d}"
        directory = self.artifact_root / artifact_id
        directory.mkdir(parents=True, exist_ok=False)
        self._artifacts[artifact_id] = directory
        result_path = directory / "result.json"
        replacements = {
            "{python}": self.python_executable,
            "{workspace}": str(self.workspace),
            "{nexus_root}": str(self.nexus_root),
        }
        argv = [self._replace_tokens(value, replacements) for value in command.argv]
        environment = os.environ.copy()
        environment["NEXUS_PROBE_INPUT_JSON"] = json.dumps(inputs, sort_keys=True)
        environment["NEXUS_PROBE_RESULT_PATH"] = str(result_path)
        existing = environment.get("PYTHONPATH", "")
        environment["PYTHONPATH"] = os.pathsep.join(
            value
            for value in (str(self.workspace), str(self.nexus_root), existing)
            if value
        )
        timed_out = False
        try:
            completed = subprocess.run(
                argv,
                cwd=self.workspace,
                env=environment,
                capture_output=True,
                text=True,
                timeout=command.timeout_seconds,
                check=False,
                shell=False,
            )
            stdout, stderr, exit_code = (
                completed.stdout,
                completed.stderr,
                completed.returncode,
            )
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            stdout = self._timeout_text(exc.stdout)
            stderr = self._timeout_text(exc.stderr)
            exit_code = None
        (directory / "stdout.log").write_text(stdout, encoding="utf-8")
        (directory / "stderr.log").write_text(stderr, encoding="utf-8")
        result = self._load_probe_result(result_path)
        result.update(
            {
                "artifact_id": artifact_id,
                "observation_id": artifact_id,
                "exit_code": exit_code,
                "timed_out": timed_out,
            }
        )
        return result

    def read_artifact(self, artifact_id: str, section: str) -> dict[str, Any]:
        if section not in self.scenario.environment.artifact_sections:
            raise ContractError(f"artifact section is not declared: {section}")
        try:
            directory = self._artifacts[artifact_id]
        except KeyError as exc:
            raise ContractError(f"artifact is not known to this run: {artifact_id}") from exc
        path = directory / ("result.json" if section == "result" else f"{section}.log")
        if not path.is_file():
            raise ContractError(f"artifact section does not exist: {artifact_id}/{section}")
        data = path.read_bytes()
        truncated = len(data) > self.max_artifact_bytes
        content = data[: self.max_artifact_bytes].decode("utf-8", errors="replace")
        return {
            "artifact_id": artifact_id,
            "section": section,
            "content": content,
            "truncated": truncated,
        }

    def _workspace_values(self) -> dict[str, Any]:
        return {
            "exists": self.workspace.is_dir(),
            "revision": self._git("rev-parse", "HEAD"),
            "branch": self._git("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(self._git("status", "--porcelain")),
            "python_version": sys.version.split()[0],
        }

    def _resource(self, resource_id: str):
        try:
            return self.scenario.environment.resource_map[resource_id]
        except KeyError as exc:
            raise ContractError(f"resource is not declared: {resource_id}") from exc

    def _git(self, *arguments: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(self.workspace), *arguments],
            capture_output=True,
            text=True,
            check=False,
            shell=False,
        )
        if completed.returncode:
            raise ContractError(completed.stderr.strip() or "git inspection failed")
        return completed.stdout.strip()

    @staticmethod
    def _replace_tokens(value: str, replacements: dict[str, str]) -> str:
        for token, replacement in replacements.items():
            value = value.replace(token, replacement)
        if re.search(r"\{[a-z_]+\}", value):
            raise ContractError(f"unsupported probe command placeholder: {value}")
        return value

    @staticmethod
    def _timeout_text(value: str | bytes | None) -> str:
        if value is None:
            return ""
        return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value

    @staticmethod
    def _load_probe_result(path: Path) -> dict[str, Any]:
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return {"reproduced": False, "probe_error": str(exc)}
        if not isinstance(result, dict):
            return {"reproduced": False, "probe_error": "probe result is not an object"}
        return result
