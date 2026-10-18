"""Creation of isolated, pinned source worktrees for scenario runs."""

from __future__ import annotations

import subprocess
from pathlib import Path


class WorktreeError(RuntimeError):
    """Raised when an isolated worktree cannot be prepared safely."""


def create_isolated_worktree(repository: Path, destination: Path, revision: str) -> str:
    repository = Path(repository).resolve()
    destination = Path(destination).resolve()
    if not repository.is_dir():
        raise WorktreeError(f"repository does not exist: {repository}")
    if destination.exists():
        raise WorktreeError(f"worktree destination already exists: {destination}")
    _git(repository, "rev-parse", "--is-inside-work-tree")
    _git(repository, "cat-file", "-e", f"{revision}^{{commit}}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _git(repository, "worktree", "add", "--detach", str(destination), revision)
    return _git(destination, "rev-parse", "HEAD")


def _git(repository: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if completed.returncode:
        raise WorktreeError(completed.stderr.strip() or "git command failed")
    return completed.stdout.strip()
