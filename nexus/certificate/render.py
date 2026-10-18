"""Human-facing renderings of a certificate: chat notification and morning summary."""

from __future__ import annotations


def _mmss(seconds: float | None) -> str:
    if seconds is None:
        return "–"
    s = int(round(seconds))
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


def notification_preview(cert: dict, channel: str = "#sre-oncall") -> dict:
    """A chat message for the on-call channel. Rendered as a preview; nothing is sent."""
    state = cert["terminal_state"]
    icon = {"VERIFIED": "✅", "ROLLED_BACK": "↩️", "REQUIRES_APPROVAL": "🟠", "ABSTAIN": "⏸️"}.get(state, "ℹ️")
    t = cert["timeline"]
    checks = (cert.get("verification") or {}).get("checks", [])
    passed = sum(c["passed"] for c in checks)
    lines = [
        f"{icon} *{state.replace('_', ' ')}* · {cert['incident']['title']} on {cert['incident'].get('target') or 'fleet'}",
        f"Detected {t.get('detected_clock', '–')} · repaired {t.get('acted_clock', '–')} · verified {t.get('closed_clock', '–')}",
        f"Root cause: {(cert.get('diagnosis') or {}).get('summary', 'not diagnosed')}",
        f"Repair: {(cert.get('repair') or {}).get('label') or 'none'} · rollback token {(cert.get('repair') or {}).get('rollback_token') or 'n/a'}",
        f"Independent checks: {passed}/{len(checks)} passed · certificate {cert['certificate_id']}",
    ]
    return {"channel": channel, "sent": False, "text": "\n".join(lines)}


def morning_summary(cert: dict) -> dict:
    t = cert["timeline"]
    return {
        "headline": f"{cert['incident']['title']}: {cert['terminal_state'].replace('_', ' ').lower()} at {t.get('closed_clock', '–')}",
        "detected": t.get("detected_clock"),
        "repaired": t.get("acted_clock"),
        "verified": t.get("closed_clock"),
        "time_to_detect": _mmss(t.get("time_to_detect_s")),
        "time_to_recover": _mmss(t.get("time_to_recover_s")),
        "dashboards_alerted": cert.get("dashboards_alerted"),
        "certificate_id": cert["certificate_id"],
    }
