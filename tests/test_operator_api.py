import os
import threading
import time
import types
import unittest

os.environ["NEXUS_OPERATOR_TOKEN"] = "op-key"

from fastapi.testclient import TestClient  # noqa: E402

from apps.operator import main  # noqa: E402

AUTH = {"Authorization": "Bearer op-key"}


class FakeEpisodes:
    """Stands in for nexus.eval.episode so no test touches a fleet."""

    def __init__(self):
        self.FAULTS = {"vllm-32926": {"fix": ["a"]}, "noop": {"set": "v1", "expect_action": False}}
        self.SOLVERS = {"rules": None, "agent": None}
        self.release = threading.Event()
        self.calls = []

    def run_episode(self, name, solver):
        self.calls.append((name, solver))
        self.release.wait(5)
        if name == "noop" and solver == "agent":
            raise RuntimeError("agent unreachable")
        return {"fault": name, "solver": solver, "at": "2026-10-18T05:00:00+00:00", "terminal_state": "VERIFIED",
                "success": True, "false_verified": False, "solve_seconds": 1.0, "run_id": None}


class OperatorApiTests(unittest.TestCase):
    def setUp(self):
        main.TOKEN = "op-key"
        main.jobs.clear()
        self.fake = FakeEpisodes()
        self.original, main.runner = main.runner, lambda: self.fake
        self.client = TestClient(main.app)

    def tearDown(self):
        self.fake.release.set()
        main.worker.submit(lambda: None).result(5)  # drain the job thread before the next test
        main.runner = self.original

    def wait(self, job_id, state):
        for _ in range(100):
            job = self.client.get(f"/jobs/{job_id}", headers=AUTH).json()
            if job["state"] == state:
                return job
            time.sleep(0.05)
        self.fail(f"{job_id} never reached {state}: {job}")

    def test_every_route_needs_the_token(self):
        for path in ("/faults", "/jobs", "/runs", "/scoreboard", "/health"):
            self.assertEqual(self.client.get(path).status_code, 401, path)
        self.assertEqual(self.client.post("/jobs", json={"fault": "noop"}).status_code, 401)
        main.TOKEN = ""
        self.assertEqual(self.client.get("/faults", headers=AUTH).status_code, 503)

    def test_only_named_faults_and_solvers(self):
        self.assertEqual(self.client.post("/jobs", json={"fault": "rm -rf /"}, headers=AUTH).status_code, 400)
        self.assertEqual(self.client.post("/jobs", json={"fault": "noop", "solver": "x"}, headers=AUTH).status_code,
                         400)
        names = {f["name"]: f for f in self.client.get("/faults", headers=AUTH).json()}
        self.assertTrue(names["noop"]["heldout"])
        self.assertFalse(names["vllm-32926"]["heldout"])
        self.assertFalse(names["noop"]["expect_action"])
        self.assertEqual(self.fake.calls, [])

    def test_one_job_at_a_time(self):
        resp = self.client.post("/jobs", json={"fault": "vllm-32926"}, headers=AUTH)
        self.assertEqual(resp.status_code, 202)
        job_id = resp.json()["job_id"]
        self.wait(job_id, "running")
        self.assertEqual(self.client.get("/health", headers=AUTH).json()["active_job"], job_id)
        busy = self.client.post("/jobs", json={"fault": "noop"}, headers=AUTH)
        self.assertEqual(busy.status_code, 409)
        self.fake.release.set()
        job = self.wait(job_id, "done")
        self.assertEqual(job["episode"]["terminal_state"], "VERIFIED")
        self.assertEqual(job["run_ids"], [])  # rules solver: no agent trail
        self.assertEqual(self.client.post("/jobs", json={"fault": "noop"}, headers=AUTH).status_code, 202)

    def test_a_failed_episode_is_reported(self):
        self.fake.release.set()
        job_id = self.client.post("/jobs", json={"fault": "noop", "solver": "agent"}, headers=AUTH).json()["job_id"]
        job = self.wait(job_id, "failed")
        self.assertIn("agent unreachable", job["error"])

    def test_results_are_served_on_the_box(self):
        self.assertIn("batches", self.client.get("/scoreboard", headers=AUTH).json())
        self.assertEqual(self.client.get("/runs/run-96915174", headers=AUTH).json()["terminal"], "VERIFIED")


if __name__ == "__main__":
    unittest.main()
