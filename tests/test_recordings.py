"""Recorded fleet runs (evidence/agent): loading, pairing with referee episodes, and the HTTP API."""

import json
import shutil

import pytest
from fastapi.testclient import TestClient

from nexus import recordings

SUMMARY_KEYS = {
    "id", "fault", "title", "target", "solver", "controller", "environment", "serving_image", "started_at",
    "agent_ended_at", "ended_at", "agent_outcome", "failure", "terminal_state", "success", "false_verified",
    "solve_seconds", "tool_calls", "evidence_count", "summary", "action",
}


@pytest.fixture(autouse=True)
def default_root(monkeypatch):
    monkeypatch.delenv("NEXUS_RECORDINGS_DIR", raising=False)


@pytest.fixture(scope="module")
def client():
    from apps.twin import server

    return TestClient(server.app)  # no `with`: the lifespan (simulation loop, process pool) never starts


def summaries() -> dict[str, dict]:
    return {s["id"]: s for s in recordings.list_recordings()}


def copy_run(root, run_id="run-8bf1324b"):
    shutil.copytree(recordings.DEFAULT_ROOT / "runs" / run_id, root / "runs" / run_id)


# ------------------------------------------------------------------ loader


def test_finds_all_ten_runs_newest_first():
    rows = recordings.list_recordings()
    assert len(rows) == 10
    assert [r["started_at"] for r in rows] == sorted((r["started_at"] for r in rows), reverse=True)


def test_summary_keys_are_exactly_the_contract():
    for row in recordings.list_recordings():
        assert set(row) == SUMMARY_KEYS


@pytest.mark.parametrize(
    "run_id, episode_at, state",
    [
        ("run-8bf1324b", "2026-10-18T02:09:05+00:00", "VERIFIED"),
        ("run-2ee04878", "2026-10-18T01:23:19+00:00", "ABSTAIN"),
        ("run-9c936df3", "2026-10-18T01:38:27+00:00", "VERIFIED"),
        ("run-a12ed62b", "2026-10-18T02:14:37+00:00", "VERIFIED"),
    ],
)
def test_runs_pair_with_their_referee_episode(run_id, episode_at, state):
    s = summaries()[run_id]
    assert s["ended_at"] == episode_at
    assert s["terminal_state"] == state


def test_each_episode_pairs_with_exactly_one_run():
    ended = [s["ended_at"] for s in recordings.list_recordings()]
    assert None not in ended
    assert len(set(ended)) == 10


def test_verified_run_summary():
    s = summaries()["run-8bf1324b"]
    assert s["terminal_state"] == "VERIFIED"
    assert s["success"] is True and s["false_verified"] is False
    assert s["agent_outcome"] == "completed" and s["failure"] is None
    assert s["tool_calls"] == 5 and s["evidence_count"] == 8
    assert "Nemotron" in s["controller"]
    assert s["fault"] == "vllm-32926" and s["title"] == "Silent tool-call failure"
    assert s["target"] == "target-a" and s["solver"] == "agent"
    assert s["environment"] == "nexus-brev-fleet"
    assert s["serving_image"] == "vllm/vllm-openai:v0.27.1"
    assert s["started_at"] == "2026-10-18T02:07:34.784071+00:00"
    assert s["agent_ended_at"] == "2026-10-18T02:07:46.953046+00:00"
    assert s["solve_seconds"] == 89.3
    assert s["action"] == {"tool": "apply-serving-profile", "service": "target-a", "profile": "qwen25-coder-7b.tools-template"}
    assert s["summary"].startswith("Diagnosed root cause: target-a")


def test_failed_run_summary():
    s = summaries()["run-447c63a9"]
    assert s["agent_outcome"] == "failed"
    assert s["failure"].startswith("ContractError")
    assert s["terminal_state"] == "ABSTAIN" and s["success"] is False
    assert s["action"] is None and s["target"] is None and s["serving_image"] is None


def test_detail_has_events_in_order_evidence_and_episode():
    d = recordings.get_recording("run-8bf1324b")
    assert d["summary"] == summaries()["run-8bf1324b"]
    sequences = [e["sequence"] for e in d["events"]]
    assert sequences == sorted(sequences) and len(sequences) == 36
    assert list(d["evidence"]) == [f"ev-{i:03d}" for i in range(1, 9)]
    assert d["evidence"]["ev-005"]["content"]["configuration"]["tool_call_parser"] == "hermes"
    assert [row["evidence_id"] for row in d["evidence_index"]] == list(d["evidence"])
    assert d["episode"]["at"] == "2026-10-18T02:09:05+00:00"


@pytest.mark.parametrize("run_id", ["run-ffffff", "../x", "run-zz", "../runs/run-8bf1324b", "RUN-8BF1324B", "", None])
def test_unknown_and_unsafe_ids_return_none(run_id):
    assert recordings.get_recording(run_id) is None


def test_env_var_pointing_at_an_empty_dir_yields_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RECORDINGS_DIR", str(tmp_path))
    assert recordings.list_recordings() == []
    assert recordings.get_recording("run-8bf1324b") is None
    assert recordings.list_recordings(tmp_path / "missing") == []


def test_a_run_without_an_episode_still_loads(tmp_path):
    copy_run(tmp_path)
    (row,) = recordings.list_recordings(tmp_path)
    assert row["id"] == "run-8bf1324b" and row["agent_outcome"] == "completed"
    assert row["terminal_state"] is None and row["ended_at"] is None and row["success"] is None
    assert row["target"] == "target-a"  # from the agent's validated plan
    assert recordings.get_recording("run-8bf1324b", tmp_path)["episode"] is None


def test_an_episode_naming_its_run_links_directly(tmp_path):
    copy_run(tmp_path)
    (tmp_path / "episodes").mkdir()
    episode = {"fault": "kill-b", "solver": "agent", "at": "2030-01-01T00:00:00+00:00", "run_id": "run-8bf1324b", "terminal_state": "VERIFIED"}
    (tmp_path / "episodes" / "late.json").write_text(json.dumps(episode))
    (row,) = recordings.list_recordings(tmp_path)
    assert row["ended_at"] == "2030-01-01T00:00:00+00:00"  # far outside the time window, but linked by id
    assert row["fault"] == "kill-b" and row["title"] == "kill-b"


def test_new_files_are_seen_without_a_restart(tmp_path):
    copy_run(tmp_path, "run-8bf1324b")
    assert len(recordings.list_recordings(tmp_path)) == 1
    copy_run(tmp_path, "run-447c63a9")
    assert [r["id"] for r in recordings.list_recordings(tmp_path)] == ["run-8bf1324b", "run-447c63a9"]


def test_results_are_copies(tmp_path):
    copy_run(tmp_path)
    recordings.list_recordings(tmp_path)[0]["id"] = "mutated"
    recordings.get_recording("run-8bf1324b", tmp_path)["events"].clear()
    assert recordings.list_recordings(tmp_path)[0]["id"] == "run-8bf1324b"
    assert len(recordings.get_recording("run-8bf1324b", tmp_path)["events"]) == 36


# --------------------------------------------------------------------- API


def test_api_lists_recordings(client):
    r = client.get("/api/recordings")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 10 and set(rows[0]) == SUMMARY_KEYS


def test_api_recording_detail_and_404(client):
    r = client.get("/api/recordings/run-8bf1324b")
    assert r.status_code == 200
    assert r.json()["summary"]["terminal_state"] == "VERIFIED"
    assert client.get("/api/recordings/run-ffffff").status_code == 404
    assert client.get("/api/recordings/run-zz").status_code == 404


def test_api_record_json_and_download(client):
    r = client.get("/api/recordings/run-8bf1324b/record.json?download=1")
    assert r.status_code == 200
    assert r.headers["content-disposition"] == 'attachment; filename="run-8bf1324b.json"'
    assert r.json()["summary"]["id"] == "run-8bf1324b"
    assert "content-disposition" not in client.get("/api/recordings/run-8bf1324b/record.json").headers
    assert client.get("/api/recordings/run-ffffff/record.json").status_code == 404


def test_api_recording_certificate_pdf(client):
    r = client.get("/api/recordings/run-447c63a9/certificate.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"] == 'attachment; filename="run-447c63a9-certificate.pdf"'
    assert r.content.startswith(b"%PDF-") and b"%%EOF" in r.content
    assert client.get("/api/recordings/run-ffffff/certificate.pdf").status_code == 404


def test_api_twin_certificate_pdf(client):
    r = client.get("/api/certificates/fixture-vllm-32926-prior/pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"] == 'attachment; filename="fixture-vllm-32926-prior.pdf"'
    assert r.content.startswith(b"%PDF-") and b"%%EOF" in r.content
    assert client.get("/api/certificates/no-such-certificate/pdf").status_code == 404
    # The JSON routes beside it are unchanged.
    assert client.get("/api/certificates/fixture-vllm-32926-prior").json()["certificate_id"] == "fixture-vllm-32926-prior"
    assert client.get("/api/certificates/fixture-vllm-32926-prior/summary").status_code == 200
