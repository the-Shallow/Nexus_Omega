"""External adapters used by the agent composition root."""

from .events import JsonlEventLog
from .nemotron import (
    ModelClientError,
    NemotronClient,
    ScriptedNemotronClient,
    VLLMClientConfig,
    VLLMNemotronClient,
)
from .repository import BoundedRepository
from .local_workspace import LocalWorkspaceProvider
from .target import (
    EnvironmentClientError,
    EnvironmentProvider,
    HttpEnvironmentConfig,
    HttpEnvironmentProvider,
)
from .worktrees import WorktreeError, create_isolated_worktree

__all__ = [
    "BoundedRepository",
    "EnvironmentClientError",
    "EnvironmentProvider",
    "HttpEnvironmentConfig",
    "HttpEnvironmentProvider",
    "JsonlEventLog",
    "LocalWorkspaceProvider",
    "ModelClientError",
    "NemotronClient",
    "ScriptedNemotronClient",
    "VLLMClientConfig",
    "VLLMNemotronClient",
    "WorktreeError",
    "create_isolated_worktree",
]
