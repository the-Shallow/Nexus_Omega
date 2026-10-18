"""Evaluation scenario catalogs and benchmark-facing contracts."""

from .catalog import IssueCandidate, IssueCandidateCatalog
from .scenario import ScenarioDefinition
from .verification import VerificationReport, verify_diagnosis, verify_repair_reproduction

__all__ = [
    "IssueCandidate",
    "IssueCandidateCatalog",
    "ScenarioDefinition",
    "VerificationReport",
    "verify_diagnosis",
    "verify_repair_reproduction",
]
