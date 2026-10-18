"""Path-contained, bounded repository reads for diagnostic context."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from ..agent.contracts import ContractError


TEXT_SUFFIXES = {
    ".json",
    ".jinja",
    ".md",
    ".py",
    ".sh",
    ".toml",
    ".yaml",
    ".yml",
}


class BoundedRepository:
    def __init__(
        self,
        root: Path,
        *,
        allowed_roots: tuple[str, ...] = (
            "apps",
            "nexus",
            "runtime",
            "scripts",
            "tests",
        ),
        max_file_bytes: int = 1_000_000,
    ) -> None:
        self.root = Path(root).resolve()
        self.allowed_root_names = tuple(allowed_roots)
        self.allowed_roots = tuple(
            self._resolve_allowed_root(item) for item in allowed_roots
        )
        self.max_file_bytes = max_file_bytes

    def search(
        self,
        query: str,
        paths: list[str],
        limit: int,
    ) -> dict[str, Any]:
        if not query.strip():
            raise ContractError("repository search query must not be blank")
        scopes = [self._resolve_scope(path) for path in paths]
        matches: list[dict[str, Any]] = []
        visited: set[Path] = set()
        truncated = False
        for scope in scopes:
            candidates = [scope] if scope.is_file() else sorted(scope.rglob("*"))
            for candidate in candidates:
                resolved = candidate.resolve()
                if resolved in visited or not self._is_allowed_file(resolved):
                    continue
                visited.add(resolved)
                text = resolved.read_text(encoding="utf-8", errors="replace")
                digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
                for line_number, line in enumerate(text.splitlines(), start=1):
                    if query in line:
                        if len(matches) >= limit:
                            truncated = True
                            break
                        matches.append(
                            {
                                "path": resolved.relative_to(self.root).as_posix(),
                                "line": line_number,
                                "text": line,
                                "sha256": digest,
                            }
                        )
                if truncated:
                    break
            if truncated:
                break
        return {
            "query": query,
            "paths": paths,
            "matches": matches,
            "truncated": truncated,
        }

    def read_file(
        self,
        path: str,
        start_line: int,
        end_line: int,
    ) -> dict[str, Any]:
        if end_line < start_line:
            raise ContractError("end_line must be greater than or equal to start_line")
        if end_line - start_line + 1 > 250:
            raise ContractError("one file request may contain at most 250 lines")
        resolved = self._resolve_scope(path)
        if not self._is_allowed_file(resolved):
            raise ContractError(f"path is not an allowed text file: {path}")
        text = resolved.read_text(encoding="utf-8", errors="replace")
        all_lines = text.splitlines()
        selected = all_lines[start_line - 1 : end_line]
        return {
            "path": resolved.relative_to(self.root).as_posix(),
            "start_line": start_line,
            "end_line": start_line + len(selected) - 1 if selected else start_line - 1,
            "lines": [
                {"line": start_line + offset, "text": line}
                for offset, line in enumerate(selected)
            ],
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "truncated": end_line < len(all_lines),
        }

    def _resolve_allowed_root(self, path: str) -> Path:
        candidate = (self.root / path).resolve()
        if candidate == self.root or self.root not in candidate.parents:
            raise ValueError(f"allowed repository root escapes project: {path}")
        return candidate

    def _resolve_scope(self, path: str) -> Path:
        candidate_path = Path(path)
        if candidate_path.is_absolute():
            raise ContractError("repository paths must be relative")
        candidate = (self.root / candidate_path).resolve()
        if not any(
            candidate == allowed or allowed in candidate.parents
            for allowed in self.allowed_roots
        ):
            raise ContractError(f"repository path is outside the allow-list: {path}")
        if not candidate.exists():
            raise ContractError(f"repository path does not exist: {path}")
        return candidate

    def _is_allowed_file(self, path: Path) -> bool:
        if not any(
            path == allowed or allowed in path.parents
            for allowed in self.allowed_roots
        ):
            return False
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            return False
        try:
            return path.stat().st_size <= self.max_file_bytes
        except OSError:
            return False
