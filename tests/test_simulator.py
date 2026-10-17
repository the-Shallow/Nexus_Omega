import pytest

from nexus.simulator import Twin, actions, faults, telemetry, whatif


@pytest.fixture(scope="module")
def warm() -> Twin:
    twin = Twin(seed=7)
    twin.advance(90)
    return twin


def last(twin: Twin) -> dict:
    return twin.state.series[-1]


def test_baseline_meets_slo(warm):
    k = last(warm)
    assert k["slo_ok"]
    assert k["canary"] == 1.0
    assert 25 < k["rps_in"] < 50
    assert 18.0 <= k["supply_c"] < 19.0


def test_same_seed_is_deterministic():
    a, b = Twin(seed=3), Twin(seed=3)
    a.advance(60)
    b.advance(60)
    assert list(a.state.series) == list(b.state.series)


def test_fork_does_not_touch_original(warm):
    before = last(warm)
    fork = warm.fork(seed=1)
    faults.inject(fork, "worker_crash")
    fork.advance(10)
    assert warm.state.workers["vllm-1"].state == "ready"
    assert last(warm) == before


def test_hung_worker_passes_health_but_times_out(warm):
    twin = warm.fork(seed=2)
    faults.inject(twin, "worker_hang", "vllm-5")
    twin.advance(60)
    w = twin.state.workers["vllm-5"]
    assert w.healthy, "a paused engine still answers /health"
    assert not w.canary_ok
    assert last(twin)["error_rate"] > 0.05


def test_silent_tool_failure_is_200_ok(warm):
    twin = warm.fork(seed=2)
    faults.inject(twin, "tool_parser", "vllm-0,vllm-1")
    twin.advance(30)
    k = last(twin)
    assert k["error_rate"] < 0.01, "no HTTP errors"
    assert k["silent_rate"] > 0.1
    assert not k["slo_ok"], "the canary still catches it"


def test_patch_config_fixes_parser_after_restart(warm):
    twin = warm.fork(seed=2)
    faults.inject(twin, "tool_parser", "vllm-0")
    actions.apply_action(twin, "patch_config", {"workers": ["vllm-0"]})
    twin.advance(60)
    assert twin.state.workers["vllm-0"].tool_ok
    assert last(twin)["canary"] == 1.0


def test_xid_crash_loops_until_cordoned(warm):
    twin = warm.fork(seed=2)
    faults.inject(twin, "gpu_xid", "A4-n2")
    actions.apply_action(twin, "restart_worker", {"worker": "vllm-2"})
    twin.advance(60)
    assert twin.state.workers["vllm-2"].state == "crashed"
    actions.apply_action(twin, "cordon_node", {"node": "A4-n2"})
    twin.advance(15)
    assert last(twin)["canary"] == 1.0


def test_crah_failure_heats_and_throttles(warm):
    twin = warm.fork(seed=2)
    faults.inject(twin, "crah_failure", "CRAH-1")
    twin.advance(150)
    k = last(twin)
    assert k["supply_c"] > 30
    assert k["throttled"] > 0


def test_rollback_restores_weight(warm):
    twin = warm.fork(seed=2)
    change = actions.apply_action(twin, "drain_worker", {"worker": "vllm-3"})
    assert twin.state.workers["vllm-3"].weight == 0
    actions.rollback(twin, change["token"])
    assert twin.state.workers["vllm-3"].weight == 1.0


def test_restart_is_not_reversible(warm):
    twin = warm.fork(seed=2)
    change = actions.apply_action(twin, "restart_worker", {"worker": "vllm-3"})
    with pytest.raises(ValueError):
        actions.rollback(twin, change["token"])


@pytest.mark.parametrize(
    "kind, target, expected",
    [
        ("worker_hang", "vllm-5", "cycle-vllm-5"),
        ("gpu_xid", "A4-n2", "cordon-A4-n2"),
        ("crah_failure", "CRAH-1", "pause-batch-all"),
        ("power_feed_loss", "UPS-A", "cap-batch-250"),
    ],
)
def test_preview_recommends_runbook_fix(warm, kind, target, expected):
    twin = warm.fork(seed=2)
    faults.inject(twin, kind, target)
    twin.advance(20)
    result = whatif.preview_twin(twin, seeds=(1, 2))
    assert result["recommended"] == expected
    noop = next(c for c in result["candidates"] if c["id"] == "noop")
    best = result["candidates"][0]
    assert best["slo_fraction"] > noop["slo_fraction"]


def test_frame_and_metrics_render(warm):
    twin = warm.fork(seed=2)
    f = telemetry.frame(twin, 0)
    assert len(f["gpu"]["temp"]) == 512
    assert {w["id"] for w in f["workers"]} == set(twin.state.workers)
    text = telemetry.prometheus(twin)
    assert 'DCGM_FI_DEV_GPU_TEMP{gpu="0",Hostname="A1-n0"' in text
    assert "vllm:num_requests_waiting" in text


def test_catalog_links_failure_candidates():
    entries = {e["kind"]: e for e in faults.catalog()}
    assert entries["worker_crash"]["upstream_url"].endswith("/56943")
    assert entries["crah_failure"]["live_episode"] == "simulated"
    assert entries["tool_parser"]["live_episode"] == "real"


def test_drained_restart_waits_for_inflight(warm):
    twin = warm.fork(seed=2)
    w = twin.state.workers["vllm-0"]
    assert w.running, "warm worker has in-flight requests"
    errors_before = sum(1 for e in w.window if e[3] in ("err", "timeout"))
    actions.apply_action(twin, "restart_worker", {"worker": "vllm-0", "readmit": True})
    assert w.state == "ready" and w.weight == 0 and w.drain_deadline is not None
    twin.advance(25)
    assert w.state == "restarting"
    errors_after = sum(1 for e in w.window if e[3] in ("err", "timeout"))
    assert errors_after - errors_before <= 2, "draining should let in-flight requests finish"
    twin.advance(50)
    assert w.state == "ready" and w.weight == 1.0
