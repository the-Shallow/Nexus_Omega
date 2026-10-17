"""File-backed certificate store with signature matching.

A signature is a set of short tokens describing what was observed (for example
``http:200``, ``tool_calls:empty``, ``config:recent_change``). Matching uses
Jaccard similarity over those tokens. It is deterministic and explainable; an
embedding model (Nemotron Embed) can replace it behind the same interface.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

SEED_DIR = Path(__file__).parent / "seed"


def similarity(a: list[str] | set[str], b: list[str] | set[str]) -> float:
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a | b else 0.0


def digest(cert: dict) -> str:
    body = {k: v for k, v in cert.items() if k != "sha256"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class CertificateStore:
    def __init__(self, root: Path, seed_dir: Path | None = SEED_DIR) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.seed_dir = seed_dir

    def _paths(self) -> list[Path]:
        paths = sorted(self.root.glob("*.json"))
        if self.seed_dir and self.seed_dir.exists():
            paths += sorted(self.seed_dir.glob("*.json"))
        return paths

    def save(self, cert: dict) -> dict:
        cert = dict(cert)
        cert["sha256"] = digest(cert)
        (self.root / f"{cert['certificate_id']}.json").write_text(json.dumps(cert, indent=2, sort_keys=True))
        return cert

    def get(self, certificate_id: str) -> dict | None:
        for path in self._paths():
            if path.stem == certificate_id:
                return json.loads(path.read_text())
        return None

    def list(self) -> list[dict]:
        out = []
        for path in self._paths():
            cert = json.loads(path.read_text())
            out.append(
                {
                    "certificate_id": cert["certificate_id"],
                    "doctor": cert.get("doctor"),
                    "incident": cert.get("incident", {}).get("title"),
                    "terminal_state": cert.get("terminal_state"),
                    "issued_at": cert.get("issued_at"),
                    "provenance": cert.get("provenance", "twin"),
                }
            )
        return sorted(out, key=lambda c: c.get("issued_at") or "", reverse=True)

    def match(self, signature: list[str], exclude: str | None = None, limit: int = 3, threshold: float = 0.3) -> list[dict]:
        hits = []
        for path in self._paths():
            cert = json.loads(path.read_text())
            if cert["certificate_id"] == exclude:
                continue
            score = similarity(signature, cert.get("signature", []))
            if score >= threshold:
                hits.append(
                    {
                        "certificate_id": cert["certificate_id"],
                        "similarity": round(score, 2),
                        "shared": sorted(set(signature) & set(cert.get("signature", []))),
                        "incident": cert.get("incident", {}).get("title"),
                        "repair": cert.get("repair", {}).get("label"),
                        "terminal_state": cert.get("terminal_state"),
                        "issued_at": cert.get("issued_at"),
                        "provenance": cert.get("provenance", "twin"),
                    }
                )
        return sorted(hits, key=lambda h: -h["similarity"])[:limit]
