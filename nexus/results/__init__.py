"""Read-only access to real run outputs (agent trails, episodes, BFCL, gates, capacity) for the UI."""

from nexus.results.adapt import RunAdapter, snapshot
from nexus.results.store import ResultsStore

__all__ = ["ResultsStore", "RunAdapter", "snapshot"]
