import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from nexus.agent.evidence import (
    EvidenceError,
    EvidenceIntegrityError,
    EvidenceLedger,
)


FIXED_TIME = datetime(2026, 10, 17, 18, 42, 10, tzinfo=timezone.utc)


class EvidenceLedgerTests(unittest.TestCase):
    def make_ledger(self, root: Path) -> EvidenceLedger:
        return EvidenceLedger(root, clock=lambda: FIXED_TIME)

    def test_add_normalizes_and_persists_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = self.make_ledger(root)
            record = ledger.add(
                source_type="raw_generation",
                source="request:req-184",
                finding="The model emitted plain JSON.",
                content={"text": '{"name":"get_weather"}'},
                trust="untrusted",
            )

            self.assertEqual(record.evidence_id, "ev-001")
            self.assertEqual(record.collected_at, "2026-10-17T18:42:10+00:00")
            self.assertEqual(record.content_ref, "evidence/ev-001.json")
            self.assertEqual(len(record.sha256), 64)
            self.assertEqual(ledger.read_content("ev-001")["text"], '{"name":"get_weather"}')
            index = [json.loads(line) for line in (root / "evidence.jsonl").read_text().splitlines()]
            self.assertEqual(index, [record.to_dict()])

    def test_identical_source_content_is_deduplicated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = self.make_ledger(Path(directory))
            first = ledger.add(
                source_type="serving_config",
                source="service:a",
                finding="Parser is hermes.",
                content={"tool_call_parser": "hermes"},
            )
            duplicate = ledger.add(
                source_type="serving_config",
                source="service:a",
                finding="Same parser observed again.",
                content={"tool_call_parser": "hermes"},
            )

            self.assertEqual(duplicate, first)
            self.assertEqual(len(ledger.records), 1)

    def test_changed_observation_is_retained_as_conflicting_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = self.make_ledger(Path(directory))
            first = ledger.add(
                source_type="serving_config",
                source="service:a",
                finding="Parser is hermes.",
                content={"tool_call_parser": "hermes"},
            )
            changed = ledger.add(
                source_type="serving_config",
                source="service:a",
                finding="Parser is now qwen3_coder.",
                content={"tool_call_parser": "qwen3_coder"},
                conflicts_with=(first.evidence_id,),
            )

            self.assertEqual(changed.evidence_id, "ev-002")
            self.assertEqual(changed.conflicts_with, (first.evidence_id,))
            self.assertEqual(len(ledger.records), 2)

    def test_changed_observation_is_not_assumed_to_be_a_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = self.make_ledger(Path(directory))
            ledger.add(
                source_type="health",
                source="service:a",
                finding="Service is unhealthy before repair.",
                content={"healthy": False},
            )
            after = ledger.add(
                source_type="health",
                source="service:a",
                finding="Service is healthy after repair.",
                content={"healthy": True},
            )

            self.assertEqual(after.conflicts_with, ())

    def test_unknown_conflict_reference_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = self.make_ledger(Path(directory))
            with self.assertRaisesRegex(EvidenceError, "unknown IDs"):
                ledger.add(
                    source_type="trace",
                    source="request:req-1",
                    finding="Contradictory trace.",
                    content={"status": 500},
                    conflicts_with=("ev-999",),
                )

    def test_reopening_ledger_continues_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_ledger(root).add(
                source_type="log",
                source="service:a",
                finding="Startup complete.",
                content={"lines": ["ready"]},
            )
            second = self.make_ledger(root).add(
                source_type="trace",
                source="request:req-2",
                finding="No structured tool call.",
                content={"tool_calls": []},
            )

            self.assertEqual(second.evidence_id, "ev-002")

    def test_tampered_content_fails_integrity_check(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = self.make_ledger(root)
            ledger.add(
                source_type="trace",
                source="request:req-1",
                finding="Original trace.",
                content={"status": 200},
            )
            artifact = root / "evidence" / "ev-001.json"
            payload = json.loads(artifact.read_text())
            payload["content"] = {"status": 500}
            artifact.write_text(json.dumps(payload))

            with self.assertRaisesRegex(EvidenceIntegrityError, "digest mismatch"):
                ledger.read_content("ev-001")

    def test_invalid_trust_and_non_json_content_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = self.make_ledger(Path(directory))
            with self.assertRaisesRegex(EvidenceError, "trust level"):
                ledger.add(
                    source_type="issue",
                    source="issue:1",
                    finding="Untrusted issue text.",
                    content={},
                    trust="model-decides",
                )
            with self.assertRaisesRegex(EvidenceError, "JSON-serializable"):
                ledger.add(
                    source_type="file",
                    source="file:a.py",
                    finding="A set is not valid JSON.",
                    content={"bad": {1, 2}},
                )


if __name__ == "__main__":
    unittest.main()
