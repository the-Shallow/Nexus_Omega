import pickle

import pytest

from nexus.certificate import morning_summary, notification_preview, similarity
from nexus.doctors import DoctorManager, clock
from nexus.simulator import Twin, faults, whatif


def run_doctor(kind: str, tmp_path, autopilot: bool = True, approve: str | None = None, limit: int = 600):
    twin = Twin(seed=7)
    twin.advance(90)
    manager = DoctorManager(tmp_path, autopilot=autopilot)
    faults.inject(twin, kind)
    run = None
    for _ in range(limit):
        twin.advance(1.0)
        run = manager.tick(twin) or run
        active = manager.active
        if active and active.preview_request is not None and active.preview_result is None:
            blob = pickle.dumps(twin.state)
            active.preview_result = whatif.preview(twin.profile, blob, twin.now, whatif.candidate_set(twin, active.preview_request), 180, (1, 2))
        if active and active.awaiting_approval and approve:
            active.approval_choice = approve if approve != "recommended" else active.precheck["recommended"]
        if run and run.done:
            break
    return twin, manager, run


@pytest.mark.parametrize(
    "kind, doctor, diagnosis, terminal",
    [
        ("tool_parser", "tool", "parser_template_mismatch", "VERIFIED"),
        ("worker_hang", "infra", "hung_worker", "VERIFIED"),
        ("network_degrade", "infra", "network_link", "VERIFIED"),
        ("gpu_xid", "infra", "gpu_hardware", "REQUIRES_APPROVAL"),
        ("crah_failure", "infra", "cooling_loss", "REQUIRES_APPROVAL"),
    ],
)
def test_doctor_routes_diagnoses_and_closes(tmp_path, kind, doctor, diagnosis, terminal):
    _, _, run = run_doctor(kind, tmp_path)
    assert run is not None and run.done
    assert run.doctor == doctor
    assert run.diagnosis["hypothesis"] == diagnosis
    assert run.terminal == terminal
    assert all(c["passed"] for c in run.verification["checks"])


def test_tool_doctor_story(tmp_path):
    twin, manager, run = run_doctor("tool_parser", tmp_path)
    cert = run.certificate
    tools = [c["tool"] for c in cert["tool_calls"]]
    for tool in ("run_canary", "read_serving_config", "get_change_history", "read_raw_generation", "read_logs", "retrieve_incident_context"):
        assert tool in tools
    assert any(c["status"] == "error" for c in cert["tool_calls"]), "the stale trace id fails and is retried"
    assert cert["matched_certificates"][0]["certificate_id"] == "fixture-vllm-32926-prior"
    assert any(p["policy"] == "parser-only" and p["decision"] == "rejected" for p in cert["policy"])
    assert cert["dashboards_alerted"] is False, "latency and errors never breached"
    assert cert["repair"]["rollback_token"]
    assert all(w.tool_ok for w in twin.state.workers.values())
    assert [s["state"] for s in cert["states"]][:3] == ["INGEST", "DIAGNOSE", "EXPAND_CONTEXT"]
    assert manager.store.get(cert["certificate_id"])["sha256"] == cert["sha256"]


def test_approval_mode_waits_for_operator(tmp_path):
    _, _, run = run_doctor("worker_hang", tmp_path, autopilot=False, limit=40)
    assert run.awaiting_approval and run.state == "PRECHECK"
    assert run.changes == [], "nothing is mutated before authorization"


def test_declined_repair_requires_approval(tmp_path):
    _, _, run = run_doctor("worker_hang", tmp_path, autopilot=False, approve="reject")
    assert run.terminal == "REQUIRES_APPROVAL"
    assert run.changes == []


def test_second_incident_matches_first_certificate(tmp_path):
    run_doctor("worker_crash", tmp_path)
    _, _, run = run_doctor("worker_crash", tmp_path)
    assert run.matches and run.matches[0]["similarity"] >= 0.8


def test_certificate_renderings():
    sample = {
        "certificate_id": "cert-x",
        "terminal_state": "VERIFIED",
        "incident": {"title": "Silent tool-call failure", "target": "vllm-0"},
        "diagnosis": {"summary": "parser/template mismatch"},
        "repair": {"label": "Matched pair", "rollback_token": "chg-1"},
        "verification": {"checks": [{"passed": True}, {"passed": True}]},
        "timeline": {"detected_clock": "01:51:04", "acted_clock": "01:52:10", "closed_clock": "02:07:00", "time_to_detect_s": 4, "time_to_recover_s": 960},
        "dashboards_alerted": False,
    }
    note = notification_preview(sample)
    assert note["sent"] is False and "2/2" in note["text"] and "02:07:00" in note["text"]
    summary = morning_summary(sample)
    assert summary["time_to_recover"] == "16m 00s"


def test_similarity_and_clock():
    assert similarity({"a", "b"}, {"a", "b"}) == 1.0
    assert similarity({"a"}, {"b"}) == 0.0
    assert clock(0) == "01:47:00" and clock(780) == "02:00:00"
