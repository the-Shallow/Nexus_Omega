"""Bounded agent controller and typed runtime contracts."""

from .client import NemotronClient, VLLMNemotronClient
from .contracts import RepairAction, RepairPlan
from .diagnostic_tools import DiagnosticBackend, DiagnosticToolRegistry
from .evidence import EvidenceLedger, EvidenceRecord
from .repository import BoundedRepository
from .runtime import AgentController, AgentRunResult
from .policy import (
    ApprovedServingProfile,
    PolicyDecision,
    PrecheckApproval,
    PrecheckResult,
    RepairPolicy,
    RepairPrecheck,
)
from .tool_loop import ToolLoopController, ToolLoopResult
from .topology_tools import build_topology_registry

__all__ = [
    "ToolLoopController",
    "ToolLoopResult",
    "AgentController",
    "AgentRunResult",
    "DiagnosticBackend",
    "DiagnosticToolRegistry",
    "RepairAction",
    "RepairPlan",
    "ApprovedServingProfile",
    "PolicyDecision",
    "PrecheckApproval",
    "PrecheckResult",
    "RepairPolicy",
    "RepairPrecheck",
    "EvidenceLedger",
    "EvidenceRecord",
    "BoundedRepository",
    "NemotronClient",
    "VLLMNemotronClient",
    "build_topology_registry",
]
