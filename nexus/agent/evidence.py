"""Append-only, controller-owned evidence records.

Tool results are normalized here before they are shown to the model.  The
model may cite evidence IDs, but it never receives a capability that can edit
or delete an existing record.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


class EvidenceError(ValueError):
    """Raised when evidence cannot be normalized or verified."""


class EvidenceIntegrityError(EvidenceError):
    """Raised when persisted evidence no longer matches its recorded digest."""


TRUST_LEVELS = {"trusted", "untrusted"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvidenceError(f"{label} must be a non-empty string")
    return value


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise EvidenceError("evidence content must be JSON-serializable") from exc


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class EvidenceRecord:
    evidence_id: str
    source_type: str
    source: str
    collected_at: str
    finding: str
    content_ref: str
    sha256: str
    truncated: bool
    trust: str
    conflicts_with: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "evidence_id": self.evidence_id,
            "source_type": self.source_type,
            "source": self.source,
            "collected_at": self.collected_at,
            "finding": self.finding,
            "content_ref": self.content_ref,
            "sha256": self.sha256,
            "truncated": self.truncated,
            "trust": self.trust,
            "conflicts_with": list(self.conflicts_with),
        }

    @classmethod
    def from_dict(cls, value: Any) -> "EvidenceRecord":
        if not isinstance(value, dict):
            raise EvidenceError("evidence ledger entry must be an object")
        required = {
            "evidence_id",
            "source_type",
            "source",
            "collected_at",
            "finding",
            "content_ref",
            "sha256",
            "truncated",
            "trust",
            "conflicts_with",
        }
        missing = required - set(value)
        extra = set(value) - required
        if missing:
            raise EvidenceError(f"evidence entry is missing fields: {sorted(missing)}")
        if extra:
            raise EvidenceError(f"evidence entry has unsupported fields: {sorted(extra)}")
        conflicts = value["conflicts_with"]
        if not isinstance(conflicts, list) or not all(
            isinstance(item, str) for item in conflicts
        ):
            raise EvidenceError("conflicts_with must be an array of evidence IDs")
        if not isinstance(value["truncated"], bool):
            raise EvidenceError("truncated must be a boolean")
        trust = _required_text(value["trust"], "trust")
        if trust not in TRUST_LEVELS:
            raise EvidenceError(f"unsupported evidence trust level: {trust}")
        digest = _required_text(value["sha256"], "sha256")
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise EvidenceError("sha256 must be a lowercase hexadecimal digest")
        return cls(
            evidence_id=_required_text(value["evidence_id"], "evidence_id"),
            source_type=_required_text(value["source_type"], "source_type"),
            source=_required_text(value["source"], "source"),
            collected_at=_required_text(value["collected_at"], "collected_at"),
            finding=_required_text(value["finding"], "finding"),
            content_ref=_required_text(value["content_ref"], "content_ref"),
            sha256=digest,
            truncated=value["truncated"],
            trust=trust,
            conflicts_with=tuple(conflicts),
        )


class EvidenceLedger:
    """Persist normalized evidence beneath one run directory.

    ``content_ref`` values are relative to ``run_root``. Identical content from
    the same logical source is deduplicated. A changed observation from that
    source is appended and explicitly references the older records; nothing is
    overwritten.
    """

    def __init__(
        self,
        run_root: Path,
        *,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self.run_root = Path(run_root)
        self.evidence_dir = self.run_root / "evidence"
        self.index_path = self.run_root / "evidence.jsonl"
        self._clock = clock
        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        self._records = self._load_records()

    @property
    def records(self) -> tuple[EvidenceRecord, ...]:
        return tuple(self._records)

    def add(
        self,
        *,
        source_type: str,
        source: str,
        finding: str,
        content: Any,
        truncated: bool = False,
        trust: str = "trusted",
        conflicts_with: tuple[str, ...] = (),
    ) -> EvidenceRecord:
        source_type = _required_text(source_type, "source_type")
        source = _required_text(source, "source")
        finding = _required_text(finding, "finding")
        if not isinstance(truncated, bool):
            raise EvidenceError("truncated must be a boolean")
        if trust not in TRUST_LEVELS:
            raise EvidenceError(f"unsupported evidence trust level: {trust}")
        if not isinstance(conflicts_with, tuple) or not all(
            isinstance(item, str) for item in conflicts_with
        ):
            raise EvidenceError("conflicts_with must be a tuple of evidence IDs")
        if len(set(conflicts_with)) != len(conflicts_with):
            raise EvidenceError("conflicts_with must not contain duplicate IDs")
        known_ids = {record.evidence_id for record in self._records}
        unknown_conflicts = set(conflicts_with) - known_ids
        if unknown_conflicts:
            raise EvidenceError(
                f"conflicts_with contains unknown IDs: {sorted(unknown_conflicts)}"
            )

        digest = _sha256(content)
        for record in self._records:
            if (
                record.source_type == source_type
                and record.source == source
                and record.sha256 == digest
                and record.truncated == truncated
                and record.trust == trust
                and record.conflicts_with == conflicts_with
            ):
                return record

        evidence_id = f"ev-{len(self._records) + 1:03d}"
        content_ref = f"evidence/{evidence_id}.json"
        record = EvidenceRecord(
            evidence_id=evidence_id,
            source_type=source_type,
            source=source,
            collected_at=self._timestamp(),
            finding=finding,
            content_ref=content_ref,
            sha256=digest,
            truncated=truncated,
            trust=trust,
            conflicts_with=conflicts_with,
        )

        artifact = {
            "evidence_id": evidence_id,
            "source_type": source_type,
            "source": source,
            "trust": trust,
            "content": content,
        }
        artifact_path = self.run_root / content_ref
        with artifact_path.open("x", encoding="utf-8") as stream:
            json.dump(artifact, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        with self.index_path.open("a", encoding="utf-8") as stream:
            stream.write(_canonical_json(record.to_dict()) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        self._records.append(record)
        return record

    def read_content(self, evidence_id: str) -> Any:
        record = self.get(evidence_id)
        path = self.run_root / record.content_ref
        try:
            artifact = json.loads(path.read_text(encoding="utf-8"))
            content = artifact["content"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            raise EvidenceIntegrityError(
                f"cannot read evidence artifact for {evidence_id}"
            ) from exc
        if _sha256(content) != record.sha256:
            raise EvidenceIntegrityError(f"digest mismatch for {evidence_id}")
        return content

    def get(self, evidence_id: str) -> EvidenceRecord:
        for record in self._records:
            if record.evidence_id == evidence_id:
                return record
        raise EvidenceError(f"unknown evidence ID: {evidence_id}")

    def _load_records(self) -> list[EvidenceRecord]:
        if not self.index_path.exists():
            return []
        records: list[EvidenceRecord] = []
        seen: set[str] = set()
        for line_number, line in enumerate(
            self.index_path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            try:
                record = EvidenceRecord.from_dict(json.loads(line))
            except (EvidenceError, json.JSONDecodeError) as exc:
                raise EvidenceIntegrityError(
                    f"invalid evidence index entry at line {line_number}"
                ) from exc
            expected_id = f"ev-{line_number:03d}"
            if record.evidence_id != expected_id or record.evidence_id in seen:
                raise EvidenceIntegrityError(
                    f"non-sequential evidence ID at line {line_number}"
                )
            expected_ref = f"evidence/{expected_id}.json"
            if record.content_ref != expected_ref:
                raise EvidenceIntegrityError(
                    f"invalid content_ref for {record.evidence_id}"
                )
            unknown_conflicts = set(record.conflicts_with) - seen
            if unknown_conflicts:
                raise EvidenceIntegrityError(
                    f"invalid conflict references for {record.evidence_id}"
                )
            seen.add(record.evidence_id)
            records.append(record)
        return records

    def _timestamp(self) -> str:
        value = self._clock()
        if value.tzinfo is None or value.utcoffset() is None:
            raise EvidenceError("evidence clock must return a timezone-aware datetime")
        return value.isoformat(timespec="seconds")
