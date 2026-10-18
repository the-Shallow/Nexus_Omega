"""Strict loader for the issue-derived diagnostic scenario catalog."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CATALOG_FIELDS = (
    "candidate_id",
    "incident_class",
    "upstream_url",
    "status_at_review",
    "original_environment",
    "reproduction_class",
    "brev_gate",
    "execution_mode",
    "verifier",
    "decision",
)

INCIDENT_CLASSES = {
    "Tool-call correctness",
    "Process health",
    "Capacity",
    "Network",
    "Serving-code defects",
    "Abstain",
}
REPRODUCTION_CLASSES = {
    "exact_reproduction",
    "hardware_gated",
    "controlled_real_fault",
    "simulated_telemetry",
}
EXECUTION_MODES = {"real", "simulated", "hybrid"}


class CandidateCatalogError(ValueError):
    """Raised when the canonical scenario catalog violates its contract."""


@dataclass(frozen=True)
class IssueCandidate:
    candidate_id: str
    incident_class: str
    upstream_url: str
    status_at_review: str
    original_environment: str
    reproduction_class: str
    brev_gate: str
    execution_mode: str
    verifier: str
    decision: str

    @classmethod
    def from_row(cls, row: dict[str, str], line_number: int) -> "IssueCandidate":
        values: dict[str, str] = {}
        for field in CATALOG_FIELDS:
            value = row.get(field)
            if not isinstance(value, str) or not value.strip():
                raise CandidateCatalogError(
                    f"candidate row {line_number} has blank field: {field}"
                )
            values[field] = value.strip()
        if values["incident_class"] not in INCIDENT_CLASSES:
            raise CandidateCatalogError(
                f"candidate row {line_number} has unsupported incident_class: "
                f"{values['incident_class']}"
            )
        if values["reproduction_class"] not in REPRODUCTION_CLASSES:
            raise CandidateCatalogError(
                f"candidate row {line_number} has unsupported reproduction_class: "
                f"{values['reproduction_class']}"
            )
        if values["execution_mode"] not in EXECUTION_MODES:
            raise CandidateCatalogError(
                f"candidate row {line_number} has unsupported execution_mode: "
                f"{values['execution_mode']}"
            )
        if not values["upstream_url"].startswith(("https://", "derived://")):
            raise CandidateCatalogError(
                f"candidate row {line_number} has unsupported upstream URL"
            )
        return cls(**values)

    def to_dict(self) -> dict[str, str]:
        return {field: getattr(self, field) for field in CATALOG_FIELDS}


class IssueCandidateCatalog:
    """Canonical candidate definitions used by the reproduction harness.

    Candidate metadata is evaluation control data. It should be retained in the
    audit trail, but expected causes and verifier criteria must not be injected
    into the model's diagnostic prompt.
    """

    def __init__(self, candidates: tuple[IssueCandidate, ...]) -> None:
        if not candidates:
            raise CandidateCatalogError("candidate catalog must not be empty")
        by_id = {candidate.candidate_id: candidate for candidate in candidates}
        if len(by_id) != len(candidates):
            raise CandidateCatalogError("candidate IDs must be unique")
        self._candidates = candidates
        self._by_id = by_id

    @classmethod
    def from_csv(cls, path: Path) -> "IssueCandidateCatalog":
        path = Path(path)
        try:
            with path.open("r", encoding="utf-8", newline="") as stream:
                reader = csv.DictReader(stream)
                if tuple(reader.fieldnames or ()) != CATALOG_FIELDS:
                    raise CandidateCatalogError(
                        "candidate catalog columns must exactly match the canonical schema"
                    )
                candidates = tuple(
                    IssueCandidate.from_row(row, line_number)
                    for line_number, row in enumerate(reader, start=2)
                )
        except OSError as exc:
            raise CandidateCatalogError(
                f"cannot read candidate catalog: {path}"
            ) from exc
        return cls(candidates)

    @property
    def candidates(self) -> tuple[IssueCandidate, ...]:
        return self._candidates

    def get(self, candidate_id: str) -> IssueCandidate:
        try:
            return self._by_id[candidate_id]
        except KeyError as exc:
            raise CandidateCatalogError(
                f"unknown issue candidate: {candidate_id}"
            ) from exc

    def select(
        self,
        *,
        incident_class: str | None = None,
        reproduction_class: str | None = None,
        execution_mode: str | None = None,
    ) -> tuple[IssueCandidate, ...]:
        filters: dict[str, Any] = {
            "incident_class": incident_class,
            "reproduction_class": reproduction_class,
            "execution_mode": execution_mode,
        }
        return tuple(
            candidate
            for candidate in self._candidates
            if all(
                expected is None or getattr(candidate, field) == expected
                for field, expected in filters.items()
            )
        )
