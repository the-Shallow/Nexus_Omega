"""Recovery certificate PDFs: well-formed files, null-safe rendering, WinAnsi text, pagination."""

import json
import re
from pathlib import Path

import pytest

from nexus import recordings
from nexus.certificate.pdf import render_certificate_pdf, render_recording_pdf, sanitize_text

SEED = Path(__file__).resolve().parents[1] / "nexus" / "certificate" / "seed" / "fixture-vllm-32926-prior.json"


def check_pdf(pdf: bytes) -> int:
    """Assert the file is well formed (header, xref offsets, stream lengths, trailer); return its page count."""
    assert pdf.startswith(b"%PDF-1.4\n") and pdf.endswith(b"%%EOF")
    startxref = int(re.search(rb"startxref\n(\d+)\n%%EOF$", pdf).group(1))
    head = re.match(rb"xref\n0 (\d+)\n", pdf[startxref:])
    assert head, "startxref must point at the xref table"
    size = int(head.group(1))
    table = pdf[startxref + head.end():]
    assert table[:20] == b"0000000000 65535 f \n"
    for number in range(1, size):
        entry = table[20 * number: 20 * number + 20]
        assert re.fullmatch(rb"\d{10} 00000 n \n", entry)
        assert pdf[int(entry[:10]):].startswith(b"%d 0 obj\n" % number)
    assert re.search(rb"trailer\n<< /Size %d /Root 1 0 R" % size, pdf)
    for m in re.finditer(rb"<< /Length (\d+) >>\nstream\n", pdf):
        end = m.end() + int(m.group(1))
        assert pdf[end:end + 10] == b"\nendstream"
    pages = int(re.search(rb"/Type /Pages /Kids \[[^\]]*\] /Count (\d+)", pdf).group(1))
    assert pages == len(re.findall(rb"/Type /Page\b", pdf)) >= 1
    return pages


def shown(pdf: bytes) -> str:
    """All text drawn with Tj, unescaped, as one string."""
    parts = re.findall(rb"\(((?:\\.|[^\\)])*)\) Tj", pdf)
    return " ".join(re.sub(rb"\\(.)", rb"\1", p).decode("cp1252") for p in parts)


def twin_cert(**overrides) -> dict:
    """A certificate shaped like nexus.doctors.base.DoctorRun.build_certificate output."""
    kpi = {"ttft_p95": 0.215, "error_rate": 0.0, "canary": 0.5, "capacity": 1.0, "silent_rate": 0.37, "slo_ok": False, "t": 102.1}
    cert = {
        "certificate_id": "cert-015039-run-005", "doctor": "tool", "provenance": "twin",
        "controller": "rule-based stand-in (Nemotron not connected)", "issued_at": "01:50:39 (twin T+220s)", "run_id": "run-005",
        "incident": {"title": "Silent tool-call failure", "incident_class": "Tool-call correctness", "candidate_id": "VLLM-32926",
                     "target": "vllm-0, vllm-1", "targets": ["vllm-0", "vllm-1"]},
        "diagnosis": {"hypothesis": "parser_template_mismatch", "summary": "hermes parser expects <tool_call> tags", "confidence": 0.988},
        "timeline": {"fault_clock": "01:48:35", "detected_clock": "01:48:43", "acted_clock": "01:49:06", "closed_clock": "01:50:39",
                     "time_to_detect_s": 7.8, "time_to_recover_s": 124.6},
        "states": [{"state": "INGEST", "clock": "01:48:43"}, {"state": "VERIFIED", "clock": "01:50:39"}],
        "tool_calls": [{"call_id": "call-01", "tool": "run_canary", "class": "test", "arguments": {}, "reason": "probe", "status": "ok"},
                       {"call_id": "call-02", "tool": "read_raw_generation", "class": "read", "arguments": {"request_id": "x"},
                        "reason": "raw", "status": "error", "error_code": "not_found", "error": "rotated out"}],
        "evidence": [{"evidence_id": "ev-001", "finding": "4 of 8 replicas return no tool_calls", "source_type": "canary",
                      "source": "tool_call_canary", "collected_at": "01:48:43"}],
        "hypotheses": [{"id": "parser_template_mismatch", "label": "Parser and chat template disagree", "confidence": 0.988}],
        "policy": [{"policy": "parser-only", "decision": "rejected", "reason": "single-sided repair"},
                   {"policy": "drain-patch-pairs", "decision": "approved", "reason": "within automatic policy (autopilot)"}],
        "precheck": {"seeds": [101, 202, 303], "horizon": 180.0, "recommended": "drain-patch-pairs", "candidates": [{"id": "drain-patch-pairs"}]},
        "repair": {"label": "Matched pair, 2 at a time + re-admit",
                   "actions": [{"kind": "drain_worker", "args": {"worker": "vllm-0"}},
                               {"kind": "patch_config", "args": {"workers": ["vllm-0"], "rolling": True}}],
                   "change_tokens": ["chg-2", "chg-3"], "rollback_token": "chg-2", "rollback_exercised": False},
        "verification": {"checks": [{"name": "Functional tool-call canary", "passed": True, "detail": "32/32 cases"},
                                    {"name": "Error rate ≤ 1%", "passed": False, "detail": "1.01%"}],
                         "before": kpi, "after": {**kpi, "ttft_p95": None, "canary": 1.0, "t": 219.1}},
        "prediction_vs_actual": {"metric": "ttft_p95", "samples": 93, "mae_s": 0.077},
        "dashboards_alerted": False,
        "budget": {"limits": {"max_tool_calls": 20, "max_steps": 12}, "used": {"tool_calls": 2, "steps": 10}},
        "terminal_state": "VERIFIED", "terminal_reason": "all independent checks passed for 10 s",
        "sha256": "3ccd202d20533eedf1db3502e3ed0987d150a9fee05974c6454de61c44f9d3f2",
    }
    cert.update(overrides)
    return cert


# ------------------------------------------------------------- sanitizer


def test_sanitizer_maps_characters_outside_winansi():
    assert sanitize_text("NEXUS Ω") == "NEXUS Omega"
    assert sanitize_text("a → b") == "a -> b"
    assert sanitize_text("✓ ok ✗ no") == "PASS ok FAIL no"
    assert sanitize_text("p95 ≤ 1 s, canary ≥ 99%") == "p95 <= 1 s, canary >= 99%"
    assert sanitize_text("‘it’ “quoted”") == "'it' \"quoted\""
    assert sanitize_text("line\nbreak\ttab") == "line break tab"


def test_sanitizer_keeps_winansi_characters():
    assert sanitize_text("45° 2×3 a·b 1–2 x—y é") == "45° 2×3 a·b 1–2 x—y é"
    assert sanitize_text("é") == "\xe9"  # a decomposed accent is composed, not dropped
    assert sanitize_text(None) == "None" and sanitize_text(3.5) == "3.5"


def test_text_is_winansi_encoded_and_escaped():
    pdf = render_certificate_pdf(twin_cert(incident={"title": "a (b) \\ c", "target": "45°"}, controller="Nexus Ω → ✓"))
    check_pdf(pdf)
    assert rb"a \(b\) \\ c" in pdf
    assert b"45\xb0" in pdf  # degree sign as its WinAnsi byte
    assert b"\x96" in pdf  # the en dash printed for a missing value
    assert "controller: Nexus Omega -> PASS" in shown(pdf)


# ---------------------------------------------------- twin certificates


def test_seed_fixture_renders():
    pdf = render_certificate_pdf(json.loads(SEED.read_text()))
    check_pdf(pdf)
    text = shown(pdf)
    assert "Recovery Certificate" in text and "VERIFIED" in text
    assert "FIXTURE" in text and "Silent tool-call failure" in text


def test_wordmark_draws_omega_from_the_symbol_font():
    pdf = render_certificate_pdf(twin_cert())
    assert b"/BaseFont /Symbol" in pdf
    assert b"/F4 13.5 Tf" in pdf and b"(W) Tj" in pdf
    assert b"/BaseFont /Helvetica /Encoding /WinAnsiEncoding" in pdf


def test_full_twin_certificate():
    pdf = render_certificate_pdf(twin_cert())
    assert check_pdf(pdf) >= 1
    text = shown(pdf)
    for phrase in ["SIMULATED", "SimPy digital twin", "controller: rule-based stand-in (Nemotron not connected)",
                   "VERIFIED", "all independent checks passed for 10 s", "TTFT p95 (ms)", "Tool-call canary (%)",
                   "Functional tool-call canary", "Error rate <= 1%", "PASS", "FAIL", "REJECTED", "APPROVED",
                   "drain_worker(worker=vllm-0)", "rolling=true", "chg-2", "run_canary", "1 returned an error",
                   "4 of 8 replicas return no tool_calls", "hermes parser expects <tool_call> tags", "SHA-256",
                   "3ccd202d20533eedf1db3502e3ed0987d150a9fee05974c6454de61c44f9d3f2", "Page 1 of"]:
        assert phrase in text, phrase
    assert "215" in text and "50.0" in text and "100.0" in text  # TTFT ms, canary % before/after


@pytest.mark.parametrize("cert", [
    {},
    None,
    {"certificate_id": None, "terminal_state": None, "incident": None, "timeline": None, "verification": None,
     "repair": None, "diagnosis": None, "evidence": None, "tool_calls": None, "policy": None, "states": None},
    {"certificate_id": "x", "terminal_state": "SOMETHING_NEW", "incident": [], "timeline": "?", "verification": {"checks": [None, {}]},
     "repair": {"actions": [None, {"kind": None, "args": None}]}, "evidence": [{}], "hypotheses": [{}], "budget": {"used": {"steps": 1}}},
    twin_cert(verification={"before": {}, "after": None, "checks": []}, prediction_vs_actual=None, precheck=None),
])
def test_missing_fields_render_as_dashes(cert):
    pdf = render_certificate_pdf(cert)
    check_pdf(pdf)
    assert "Recovery Certificate" in shown(pdf)


@pytest.mark.parametrize("state", ["VERIFIED", "ROLLED_BACK", "REQUIRES_APPROVAL", "ABSTAIN"])
def test_every_terminal_state_renders(state):
    pdf = render_certificate_pdf(twin_cert(terminal_state=state))
    check_pdf(pdf)
    assert state.replace("_", " ") in shown(pdf)


def test_long_evidence_lists_paginate():
    evidence = [{"evidence_id": f"ev-{i:03d}", "finding": f"finding number {i} " * 6, "source_type": "logs", "source": "vllm-0"}
                for i in range(1, 201)]
    pdf = render_certificate_pdf(twin_cert(evidence=evidence))
    pages = check_pdf(pdf)
    assert int(re.search(rb"/Count (\d+)", pdf).group(1)) == pages >= 2
    text = shown(pdf)
    assert "+ 188 more evidence items in the JSON certificate." in text  # the PDF lists the first 12
    assert f"Page 1 of {pages}" in text and f"Page {pages} of {pages}" in text


def test_long_lists_flow_onto_more_pages_with_header_and_page_numbers():
    checks = [{"name": f"Check number {i}", "passed": i % 3 != 0, "detail": f"{i}/150"} for i in range(150)]
    pdf = render_certificate_pdf(twin_cert(verification={"checks": checks}))
    pages = check_pdf(pdf)
    assert pages >= 3
    assert pdf.count(b"(W) Tj") == pages  # the header (with its Omega) repeats on every page
    text = shown(pdf)
    assert all(f"Page {n} of {pages}" in text for n in range(1, pages + 1))
    assert "Check number 0" in text and "Check number 149" in text
    assert text.count("Recovery Certificate  \xb7  cert-015039-run-005") == pages - 1  # slim header on later pages


# ------------------------------------------------------ recorded fleet runs


def test_recording_pdf_for_a_verified_run():
    pdf = render_recording_pdf(recordings.get_recording("run-8bf1324b"))
    check_pdf(pdf)
    text = shown(pdf)
    for phrase in ["RECORDED ON A REAL FLEET", "nexus-brev-fleet", "NVIDIA-Nemotron-3.5-Lightning", "run-8bf1324b",
                   "VERIFIED", "Users served through HAProxy", "Root cause fixed", "Repaired worker back in rotation",
                   "Executor's own canary", "apply-serving-profile", "patch_serving_config", "get_configuration",
                   "AT DETECTION (EV-001)", "AFTER REPAIR (REFEREE PROBE)", "240", "38", "tool_call_parser=hermes",
                   "evidence/agent/runs/run-8bf1324b/events.jsonl", "Page 1 of"]:
        assert phrase in text, phrase
    assert "FAIL" not in text


def test_recording_pdf_for_a_failed_run():
    pdf = render_recording_pdf(recordings.get_recording("run-447c63a9"))
    check_pdf(pdf)
    text = shown(pdf)
    assert "Agent run failed:" in text and "ContractError" in text
    assert "ABSTAIN" in text and "Root cause fixed" in text and "FAIL" in text
    assert "no executor record" in text


@pytest.mark.parametrize("detail", [{}, None, {"summary": None, "events": None, "episode": None},
                                    {"summary": {"id": "run-abcdef", "agent_outcome": "failed"}, "events": [{}, None], "evidence": {"ev-001": None},
                                     "evidence_index": [{"evidence_id": "ev-001"}, None], "episode": {"verification": {"route": {"a": None}}}}])
def test_recording_pdf_is_null_safe(detail):
    check_pdf(render_recording_pdf(detail))
