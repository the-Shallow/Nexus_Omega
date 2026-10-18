import asyncio
import json
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from apps.twin import live
from nexus.results import ResultsStore, snapshot

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence"
SAMPLES = ROOT / "web" / "samples"
RUN = "run-96915174"  # Nemotron fixing VLLM-32926 in Batch 1, VERIFIED by the referee


class ResultsStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = ResultsStore([EVIDENCE])

    def test_scoreboard_matches_the_evaluation_log(self):
        # The numbers in evidence/agent/README.md, rebuilt from the episode records.
        batches = {b["id"]: b for b in self.store.scoreboard()["batches"]}
        total = {k: (b["total"]["success"], b["total"]["total"], b["total"]["false_verified"])
                 for k, b in batches.items()}
        self.assertEqual(total["rules-known"], (12, 12, 0))
        self.assertEqual(total["rules-heldout"], (3, 12, 0))
        self.assertEqual(total["agent-batch1"], (7, 12, 3))
        self.assertEqual(total["agent-final-32926"], (3, 3, 0))
        self.assertEqual(batches["agent-final-32926"]["total"]["median_s"], 89.3)
        self.assertEqual(batches["agent-batch1"]["faults"]["net-latency-b"]["false_verified"], 2)

    def test_contaminated_round_is_listed_but_not_scored(self):
        contaminated = [e for e in self.store.list_episodes(solver="agent", heldout=True) if e["contaminated"]]
        self.assertEqual(len(contaminated), 4)
        scored = sum(b["total"]["total"] for b in self.store.scoreboard()["batches"] if b["solver"] == "agent")
        self.assertEqual(scored, len(self.store.list_episodes(solver="agent")) - 4)

    def test_events_tail_by_sequence(self):
        events = self.store.read_events(RUN)
        self.assertEqual([e["sequence"] for e in events], list(range(1, len(events) + 1)))
        self.assertEqual([e["sequence"] for e in self.store.read_events(RUN, after=40)],
                         list(range(41, len(events) + 1)))

    def test_ids_cannot_leave_the_roots(self):
        for bad in ("../../etc", "run-96915174/../../x", "a b"):
            with self.assertRaises(KeyError):
                self.store.read_events(bad)
        with self.assertRaises(KeyError):
            self.store.read_evidence(RUN, "../events")

    def test_snapshot_ends_with_the_referee(self):
        snap = snapshot(RUN, self.store.read_events(RUN), self.store.episode_for_run(RUN))
        kinds = [e["kind"] for e in snap["events"]]
        self.assertEqual(snap["controller"], "nemotron")
        self.assertEqual(snap["terminal"], "VERIFIED")
        self.assertEqual(kinds.count("tool_call"), snap["usage"]["tool_calls"])
        self.assertEqual(kinds[-3:], ["action", "verify", "terminal"])
        calls = [e["detail"] for e in snap["events"] if e["kind"] == "tool_call"]
        self.assertTrue(all(c["result"] for c in calls[1:]))  # describe_environment records no evidence
        self.assertEqual(calls[-1]["class"], "test")
        self.assertIn("hyp-001", [h["id"] for h in snap["hypotheses"]])

    def test_snapshot_without_an_episode_stops_at_the_handoff(self):
        snap = snapshot(RUN, self.store.read_events(RUN))
        self.assertIsNone(snap["terminal"])
        self.assertEqual(snap["state"], "PRECHECK")

    def test_bfcl_keeps_scores_and_drops_cases(self):
        rows = {r["label"]: r for r in self.store.bfcl()}
        self.assertAlmostEqual(rows["qwen25-coder-7b.tools-template"]["tool_calling_score"], 0.827, places=3)
        self.assertEqual(rows["qwen25-coder-7b.vllm-32926"]["tool_calling_score"], 0.0)
        self.assertNotIn("results", rows["qwen25-coder-7b.vllm-32926"])

    def test_capacity_flattens_the_header_rows(self):
        data = self.store.capacity("haproxy-ab")
        self.assertEqual(data["columns"][0], "Run Info · Run ID")
        self.assertTrue(all(len(r) == len(data["columns"]) for r in data["rows"]))


class TwinRoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from apps.twin.server import app

        cls.client = TestClient(app)

    def test_results_routes(self):
        self.assertEqual(self.client.get(f"/api/results/runs/{RUN}").json()["terminal"], "VERIFIED")
        self.assertEqual(self.client.get("/api/results/runs/run-nope").status_code, 404)
        episode = self.client.get("/api/results/episodes/heldout/rules-episodes~0").json()
        self.assertEqual(episode["fault"], "compound-latb-32926a")

    def test_stream_replays_and_resumes(self):
        def read(headers=None):
            with self.client.stream("GET", f"/api/runs/{RUN}/stream", headers=headers or {}) as resp:
                return resp.read().decode()
        full = read()
        ids = [int(line[4:]) for line in full.splitlines() if line.startswith("id: ")]
        self.assertEqual(ids, list(range(1, 44)))
        self.assertIn("event: referee", full)
        end = json.loads(full.split("event: end\ndata: ")[1].split("\n")[0])
        self.assertEqual(end["terminal"], "VERIFIED")
        resumed = [int(line[4:]) for line in read({"Last-Event-ID": "40"}).splitlines() if line.startswith("id: ")]
        self.assertEqual(resumed, [41, 42, 43])

    def test_break_needs_the_operator(self):
        self.assertEqual(self.client.post("/api/live/break", json={"fault": "noop"}).status_code, 503)


class LiveFrameTests(unittest.TestCase):
    def test_frame_from_the_real_samples(self):
        admin = json.loads((SAMPLES / "admin-workers.json").read_text())
        prom = {"vllm:num_requests_waiting": {"status": "success", "data": {"result": [
            {"metric": {"instance": "nexus-a:8000"}, "value": [0, "2"]}]}},
            "DCGM_FI_DEV_GPU_UTIL": json.loads((SAMPLES / "prometheus-gpu-util.json").read_text())}
        ttft = json.loads((SAMPLES / "prometheus-ttft-p95.json").read_text())

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/admin/workers":
                return httpx.Response(200, json=admin)
            query = request.url.params.get("query", "")
            body = ttft if "time_to_first_token" in query else prom.get(query, {"data": {"result": []}})
            return httpx.Response(200, json=body)

        async def frames():
            poller = live.LivePoller()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                first = await poller.frame(client)
                admin["a"]["requests"] += 10
                admin["a"]["errors"] += 1
                return first, await poller.frame(client)

        first, second = asyncio.run(frames())
        a = {w["id"]: w for w in second["workers"]}["a"]
        self.assertIsNone(first["kpi"]["error_rate"])  # no rate until there are two samples
        self.assertEqual(a["waiting"], 2.0)
        self.assertIsNone(a["ttft_p95"])  # NaN from an idle fleet stays unknown
        self.assertEqual(a["error_rate"], 0.1)
        self.assertEqual(second["flows"]["a"], {"disp": 10, "ok": 9, "err": 1, "silent": None})
        self.assertFalse(second["kpi"]["slo_ok"])  # any error breaks the route SLO
        self.assertEqual(second["gpu"]["util"], [0.0])
        self.assertTrue(second["sources"]["gateway"])


if __name__ == "__main__":
    unittest.main()
