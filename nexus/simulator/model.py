"""SimPy digital twin of a GPU inference pod.

The twin models request flow through a gateway to vLLM replicas, per-GPU power
and thermals, rack power feeds and room cooling. All quantities live in plain
dataclasses (``TwinState``); SimPy processes only advance that state. A running
twin can therefore be forked for what-if previews by copying its state and
starting fresh processes at the same simulated time.
"""

from __future__ import annotations

import copy
import heapq
import json
import math
import random
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import simpy

DT = 0.1  # request / continuous-batching step (s)
PHYS_DT = 0.5  # power and thermal step (s)
SAMPLE_DT = 1.0  # KPI sampling period (s)
WINDOW_S = 10.0  # KPI aggregation window (s)
DRAIN_GRACE_S = 20.0  # max wait for in-flight requests before a drained restart
FAILED = ("err", "timeout", "shed")
PROFILE_DIR = Path(__file__).parent / "profiles"


def load_profile(name: str = "pod-h100") -> dict:
    return json.loads((PROFILE_DIR / f"{name}.json").read_text())


def _water_fill(claims: list[float], budget: float) -> float | None:
    """Per-GPU power level L with sum(min(claim, L)) == budget, or None if the budget is not binding."""
    if sum(claims) <= budget:
        return None
    remaining, ordered = budget, sorted(claims)
    for i, c in enumerate(ordered):
        share = remaining / (len(ordered) - i)
        if c >= share:
            return share
        remaining -= c
    return None


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q / 100 * (len(ordered) - 1) + 0.5))]


@dataclass
class Request:
    rid: int
    t_arrival: float
    prompt: int
    output: int
    tool: bool
    prefill_left: float
    decode_left: float
    t_first: float | None = None

    @property
    def kv_tokens(self) -> float:
        return self.prompt + self.output - max(self.decode_left, 0.0) - self.prefill_left


@dataclass
class Gpu:
    index: int
    node: str
    local: int
    temp: float
    power_limit: float
    power: float = 0.0
    util: float = 0.0
    clock: float = 1.0  # fraction of max SM clock
    fb_used_mb: float = 0.0
    thermal_violation_s: float = 0.0
    power_violation_s: float = 0.0
    throttle: str = ""  # "", "thermal", "power"
    xid: int = 0
    fallen: bool = False


@dataclass
class Node:
    id: str
    rack: str
    slot: int
    role: str  # "inference" | "batch"
    gpus: list[int]
    worker: str | None = None
    cordoned: bool = False
    batch_util: float = 0.8
    batch_paused: bool = False


@dataclass
class Rack:
    id: str
    row: str
    index: int
    nodes: list[str]
    inlet: float = 19.0
    exhaust: float = 30.0
    power_kw: float = 0.0
    cap_kw: float | None = None
    tor_latency_s: float = 0.0
    tor_loss: float = 0.0


@dataclass
class Worker:
    id: str
    node: str
    max_num_seqs: int
    kv_capacity: float
    state: str = "ready"  # ready | hung | crashed | restarting | cordoned
    ready_at: float = 0.0
    healthy: bool = True
    weight: float = 1.0
    cap: int | None = None  # gateway in-flight cap
    tool_ok: bool = True
    pending_tool_ok: bool | None = None
    readmit: bool = False  # restore routing weight once the restart completes
    drain_deadline: float | None = None  # set while draining ahead of a restart
    running: list[Request] = field(default_factory=list)
    waiting: list[Request] = field(default_factory=list)
    kv_used: float = 0.0
    preemptions: int = 0
    restarts: int = 0
    canary_ok: bool = True
    log_rate: float = 2.0
    window: deque = field(default_factory=deque)  # (t, ttft, e2e, status)
    tokens: deque = field(default_factory=deque)  # (t, tokens)
    flow: dict = field(default_factory=lambda: {"disp": 0, "ok": 0, "err": 0, "silent": 0})


@dataclass
class Crah:
    id: str
    row: str
    capacity_kw: float
    running: bool = True


@dataclass
class TwinState:
    rng: random.Random
    supply_c: float
    gpus: list[Gpu]
    nodes: dict[str, Node]
    racks: dict[str, Rack]
    workers: dict[str, Worker]
    crahs: list[Crah]
    ups: dict[str, bool]
    queue: list[Request] = field(default_factory=list)
    throttle_rps: float | None = None
    bucket: float = 0.0
    burst: float = 1.0
    next_rid: int = 0
    it_kw: float = 0.0
    cooling_kw: float = 0.0
    pue: float = 1.0
    airflow: dict[str, float] = field(default_factory=dict)
    window: deque = field(default_factory=deque)  # (t, ttft, status, tool, tpot)
    arrivals: deque = field(default_factory=deque)
    gateway_flow: dict = field(default_factory=lambda: {"in": 0, "shed": 0})
    faults: dict[str, dict] = field(default_factory=dict)
    timers: list[tuple] = field(default_factory=list)  # heap of (t, seq, kind, payload)
    changes: dict[str, dict] = field(default_factory=dict)
    events: deque = field(default_factory=lambda: deque(maxlen=400))
    event_seq: int = 0
    series: deque = field(default_factory=lambda: deque(maxlen=1800))
    next_id: int = 0


def build_state(profile: dict, seed: int) -> TwinState:
    hall, gpu_p = profile["hall"], profile["gpu"]
    inference = {w["node"]: w["id"] for w in profile["inference"]["workers"]}
    rng = random.Random(seed)
    gpus: list[Gpu] = []
    nodes: dict[str, Node] = {}
    racks: dict[str, Rack] = {}
    for row in hall["rows"]:
        for i in range(hall["racks_per_row"]):
            rack_id = f"{row}{i + 1}"
            rack = Rack(rack_id, row, i, [])
            for slot in range(hall["nodes_per_rack"]):
                node_id = f"{rack_id}-n{slot}"
                indices = []
                for local in range(hall["gpus_per_node"]):
                    indices.append(len(gpus))
                    gpus.append(Gpu(len(gpus), node_id, local, temp=55.0, power_limit=gpu_p["tdp_w"]))
                worker = inference.get(node_id)
                nodes[node_id] = Node(
                    node_id,
                    rack_id,
                    slot,
                    "inference" if worker else "batch",
                    indices,
                    worker=worker,
                    batch_util=rng.uniform(0.7, 0.92),
                )
                rack.nodes.append(node_id)
            racks[rack_id] = rack
    inf = profile["inference"]
    workers = {
        w["id"]: Worker(w["id"], w["node"], inf["max_num_seqs"], inf["kv_capacity_tokens"])
        for w in inf["workers"]
    }
    crahs = [Crah(c["id"], c["row"], c["capacity_kw"]) for c in profile["crah"]]
    ups = {u: True for u in profile["power"]["ups"]}
    return TwinState(rng, hall["supply_setpoint_c"], gpus, nodes, racks, workers, crahs, ups)


class Twin:
    """A running digital twin. Construct from a profile, or from a state to fork."""

    def __init__(
        self,
        profile: dict | None = None,
        seed: int | None = None,
        state: TwinState | None = None,
        now: float = 0.0,
    ):
        self.profile = profile or load_profile()
        if state is None:
            state = build_state(self.profile, self.profile.get("seed", 7) if seed is None else seed)
        self.state = state
        self.env = simpy.Environment(initial_time=now)
        for proc in (
            self._arrivals,
            self._batch_loop,
            self._physics_loop,
            self._health_loop,
            self._canary_loop,
            self._sample_loop,
        ):
            self.env.process(proc())

    @property
    def now(self) -> float:
        return self.env.now

    def fork(self, seed: int | None = None) -> Twin:
        state = copy.deepcopy(self.state)
        if seed is not None:
            state.rng = random.Random(seed)
        return Twin(self.profile, state=state, now=self.env.now)

    def advance(self, seconds: float) -> None:
        self.env.run(until=self.env.now + seconds)

    # ------------------------------------------------------------------ helpers

    def log(self, level: str, msg: str, target: str | None = None, kind: str = "") -> None:
        s = self.state
        s.event_seq += 1
        s.events.append(
            {"seq": s.event_seq, "t": round(self.env.now, 1), "level": level, "kind": kind, "target": target, "msg": msg}
        )

    def new_id(self, prefix: str) -> str:
        self.state.next_id += 1
        return f"{prefix}-{self.state.next_id}"

    def schedule(self, delay: float, kind: str, payload: dict) -> None:
        s = self.state
        s.next_id += 1
        heapq.heappush(s.timers, (self.env.now + delay, s.next_id, kind, payload))

    def rack_of(self, worker: Worker) -> Rack:
        return self.state.racks[self.state.nodes[worker.node].rack]

    def in_rotation(self, w: Worker) -> bool:
        return w.weight > 0 and w.state != "cordoned"

    # --------------------------------------------------------------- mutators

    def fail_inflight(self, w: Worker, status: str = "err") -> int:
        lost = w.running + w.waiting
        for r in lost:
            self._finish(r, w, status)
        w.running, w.waiting, w.kv_used = [], [], 0.0
        return len(lost)

    def crash(self, w: Worker, reason: str) -> None:
        if w.state in ("crashed", "cordoned"):
            return
        lost = self.fail_inflight(w)
        w.state = "crashed"
        # VLLM-56943: each failing in-flight request re-logs the shared traceback.
        w.log_rate = 2.0 + 4.0 * lost * lost
        self.log("error", f"{w.id}: {reason}; {lost} in-flight requests failed", w.id, "crash")

    def restart(self, w: Worker, tool_ok: bool | None = None, readmit: bool = False) -> bool:
        """Restart an engine. With ``readmit`` it is drained first and re-admitted after a canary pass."""
        if w.state == "cordoned":
            return False
        if tool_ok is not None:
            w.pending_tool_ok = tool_ok
        if readmit:
            w.weight, w.readmit = 0.0, True
            inflight = len(w.running) + len(w.waiting)
            if w.state == "ready" and inflight:
                w.drain_deadline = self.env.now + DRAIN_GRACE_S
                self.log("info", f"{w.id}: draining {inflight} in-flight requests before restart", w.id, "drain")
                return True
        self._begin_restart(w)
        return True

    def _begin_restart(self, w: Worker) -> None:
        w.drain_deadline = None
        self.fail_inflight(w)
        w.state, w.healthy = "restarting", False
        w.ready_at = self.env.now + self.profile["inference"]["startup_s"]
        self.log("info", f"{w.id}: restarting (model load ~{self.profile['inference']['startup_s']}s)", w.id, "restart")

    def xid(self, gpu: Gpu, code: int, cause: str) -> None:
        if gpu.fallen:
            return
        gpu.xid = code
        gpu.fallen = code in (48, 79)
        node = self.state.nodes[gpu.node]
        label = {79: "GPU has fallen off the bus", 48: "double-bit ECC error", 94: "contained ECC error"}.get(code, "")
        self.log("error", f"XID {code} on {gpu.node}-g{gpu.local}: {label} ({cause})", gpu.node, "xid")
        if node.worker:
            self.crash(self.state.workers[node.worker], f"CUDA error after XID {code}")
        elif not node.cordoned:
            node.batch_paused = True
            self.log("warn", f"{node.id}: batch job failed after XID {code}", node.id, "batch")

    # ---------------------------------------------------------------- traffic

    def _rate(self) -> float:
        t = self.profile["traffic"]
        diurnal = 1 + t["diurnal_amp"] * math.sin(2 * math.pi * self.env.now / t["diurnal_period_s"])
        return t["base_rps"] * diurnal * self.state.burst

    def _arrivals(self):
        while True:
            yield self.env.timeout(self.state.rng.expovariate(self._rate()))
            self._admit(self._new_request())

    def _draw(self, median: float, sigma: float, lo: int, hi: int) -> int:
        return int(min(hi, max(lo, self.state.rng.lognormvariate(math.log(median), sigma))))

    def _new_request(self) -> Request:
        s, t = self.state, self.profile["traffic"]
        prompt = self._draw(t["prompt_median"], t["prompt_sigma"], t["prompt_min"], t["prompt_max"])
        output = self._draw(t["output_median"], t["output_sigma"], t["output_min"], t["output_max"])
        r = Request(s.next_rid, self.env.now, prompt, output, s.rng.random() < t["tool_fraction"], prompt, output)
        s.next_rid += 1
        return r

    def _admit(self, r: Request) -> None:
        s = self.state
        s.arrivals.append(self.env.now)
        s.gateway_flow["in"] += 1
        if s.throttle_rps is not None:
            if s.bucket < 1:
                self._finish(r, None, "shed")
                return
            s.bucket -= 1
        if len(s.queue) >= self.profile["gateway"]["max_queue"]:
            self._finish(r, None, "shed")
            return
        s.queue.append(r)

    def _finish(self, r: Request, w: Worker | None, status: str) -> None:
        s, now = self.state, self.env.now
        lat = self.rack_of(w).tor_latency_s if w else 0.0
        served = r.t_first is not None and status in ("ok", "silent")
        ttft = r.t_first - r.t_arrival + lat if served else None
        tpot = (now - r.t_first) / max(1, r.output - 1) if served else None
        s.window.append((now, ttft, status, r.tool, tpot))
        if status == "shed":
            s.gateway_flow["shed"] += 1
        if w is not None:
            w.window.append((now, ttft, now - r.t_arrival + lat, status))
            w.flow["err" if status in FAILED else status] += 1

    # ---------------------------------------------------------------- serving

    def _batch_loop(self):
        tick = 0
        while True:
            yield self.env.timeout(DT)
            s, now = self.state, self.env.now
            while s.timers and s.timers[0][0] <= now:
                _, _, kind, payload = heapq.heappop(s.timers)
                self._on_timer(kind, payload)
            if s.throttle_rps is not None:
                s.bucket = min(s.throttle_rps, s.bucket + s.throttle_rps * DT)
            self._dispatch()
            for w in s.workers.values():
                self._step_worker(w, now)
            tick += 1
            if tick % 5 == 0:
                self._expire(now)

    def _on_timer(self, kind: str, payload: dict) -> None:
        s = self.state
        if kind == "burst_end":
            s.burst = 1.0
            self.log("info", "traffic burst subsided", None, "traffic")
        elif kind == "restart":
            self.restart(s.workers[payload["worker"]], payload.get("tool_ok"), payload.get("readmit", False))

    def _pick(self, pool: list[Worker]) -> Worker:
        total = sum(w.weight for w in pool)
        x = self.state.rng.random() * total
        for w in pool:
            x -= w.weight
            if x <= 0:
                return w
        return pool[-1]

    def _dispatch(self) -> None:
        s = self.state
        if not s.queue:
            return
        pool = [w for w in s.workers.values() if w.healthy and self.in_rotation(w)]
        for i, r in enumerate(s.queue):
            avail = [w for w in pool if w.cap is None or len(w.running) + len(w.waiting) < w.cap]
            if not avail:
                s.queue = s.queue[i:]
                return
            w = self._pick(avail)
            w.flow["disp"] += 1
            if w.state == "crashed":  # health check has not noticed yet
                self._finish(r, w, "err")
            else:
                w.waiting.append(r)
        s.queue = []

    def clock_of(self, w: Worker) -> float:
        node = self.state.nodes[w.node]
        return min(self.state.gpus[i].clock for i in node.gpus)

    def _step_worker(self, w: Worker, now: float) -> None:
        if w.state == "restarting":
            if now >= w.ready_at:
                self._finish_restart(w)
            return
        if w.state != "ready":
            return  # hung workers accept work but make no progress
        inf = self.profile["inference"]
        clock = max(self.clock_of(w), 0.05)
        while (
            w.waiting
            and len(w.running) < w.max_num_seqs
            and w.kv_used + w.waiting[0].prefill_left <= w.kv_capacity
        ):
            r = w.waiting.pop(0)
            w.running.append(r)
            w.kv_used += r.prefill_left
        budget = inf["prefill_tps"] * DT * clock
        decoding = []
        for r in w.running:
            if r.prefill_left > 0:
                if budget > 0:
                    take = min(budget, r.prefill_left)
                    r.prefill_left -= take
                    budget -= take
                    if r.prefill_left <= 0 and r.t_first is None:
                        r.t_first = now
            else:
                decoding.append(r)
        if decoding:
            tpot = (inf["tpot_base_s"] + inf["tpot_per_seq_s"] * len(decoding)) / clock
            tok = DT / tpot
            for r in decoding:
                r.decode_left -= tok
            w.tokens.append((now, tok * len(decoding)))
        kv = sum(r.kv_tokens for r in w.running)
        while kv > w.kv_capacity and len(w.running) > 1:  # recompute-style preemption
            victim = w.running.pop()
            kv -= victim.kv_tokens
            victim.prefill_left = victim.prompt + victim.output - max(victim.decode_left, 0.0)
            w.waiting.insert(0, victim)
            w.preemptions += 1
        done = [r for r in w.running if r.decode_left <= 0]
        if done:
            rack = self.rack_of(w)
            for r in done:
                w.running.remove(r)
                kv -= r.kv_tokens
                if rack.tor_loss and self.state.rng.random() < rack.tor_loss:
                    status = "err"
                elif r.tool and not w.tool_ok:
                    status = "silent"  # HTTP 200, tool call dropped
                else:
                    status = "ok"
                self._finish(r, w, status)
        w.kv_used = max(kv, 0.0)
        if w.drain_deadline is not None and (not (w.running or w.waiting) or now >= w.drain_deadline):
            self._begin_restart(w)

    def _finish_restart(self, w: Worker) -> None:
        node = self.state.nodes[w.node]
        fallen = [g for g in (self.state.gpus[i] for i in node.gpus) if g.fallen]
        if fallen:
            w.state = "crashed"
            g = fallen[0]
            self.log("error", f"{w.id}: engine init failed, CUDA device lost (XID {g.xid} on g{g.local})", w.id, "crash")
            return
        w.state, w.restarts = "ready", w.restarts + 1
        if w.pending_tool_ok is not None:
            w.tool_ok, w.pending_tool_ok = w.pending_tool_ok, None
        self.log("info", f"{w.id}: engine ready" + (", awaiting canary before re-admit" if w.readmit else ""), w.id, "ready")

    def _expire(self, now: float) -> None:
        timeout = self.profile["traffic"]["timeout_s"]
        s = self.state
        if s.queue and now - s.queue[0].t_arrival > timeout:
            keep = []
            for r in s.queue:
                if now - r.t_arrival > timeout:
                    self._finish(r, None, "timeout")
                else:
                    keep.append(r)
            s.queue = keep
        for w in s.workers.values():
            for bucket in (w.waiting, w.running):
                stale = [r for r in bucket if now - r.t_arrival > timeout]
                for r in stale:
                    bucket.remove(r)
                    self._finish(r, w, "timeout")

    # -------------------------------------------------------- health / canary

    def _health_loop(self):
        interval = self.profile["gateway"]["health_interval_s"]
        while True:
            yield self.env.timeout(interval)
            for w in self.state.workers.values():
                # A hung (paused) engine still answers /health: the gateway keeps routing to it.
                ok = w.state in ("ready", "hung") and self.state.rng.random() >= self.rack_of(w).tor_loss * 4
                if ok != w.healthy:
                    w.healthy = ok
                    self.log("info" if ok else "warn", f"gateway: {w.id} marked {'healthy' if ok else 'unhealthy'}", w.id, "health")

    def _canary_loop(self):
        while True:
            yield self.env.timeout(self.profile["canary"]["interval_s"])
            for w in self.state.workers.values():
                rack = self.rack_of(w)
                ok = (
                    w.state == "ready"
                    and w.tool_ok
                    and rack.tor_latency_s < 0.5
                    and self.state.rng.random() >= rack.tor_loss * 2
                )
                if ok != w.canary_ok:
                    w.canary_ok = ok
                    if not ok:
                        self.log("warn", f"canary: tool-call probe failed on {w.id}", w.id, "canary")
                if ok and w.readmit:
                    w.weight, w.readmit = 1.0, False
                    self.log("ok", f"{w.id}: canary passed, re-admitted to rotation", w.id, "readmit")

    # ---------------------------------------------------------- power/thermal

    def _row_airflow(self) -> dict[str, float]:
        running = [c for c in self.state.crahs if c.running]
        flows = {}
        for row in self.profile["hall"]["rows"]:
            if any(c.row == row for c in running):
                flows[row] = 1.0
            else:
                flows[row] = 0.55 if running else 0.2
        return flows

    def _util(self, node: Node) -> float:
        if node.cordoned:
            return 0.0
        if node.role == "batch":
            return 0.02 if node.batch_paused else node.batch_util
        w = self.state.workers[node.worker]
        if w.state == "ready":
            n = len(w.running)
            return min(1.0, 0.25 + n / 24) if n else 0.04
        return 0.2 if w.state == "restarting" else 0.0

    def _physics_loop(self):
        while True:
            yield self.env.timeout(PHYS_DT)
            self._physics()

    def _physics(self) -> None:
        s, p = self.state, self.profile
        hall, gp, batch = p["hall"], p["gpu"], p["batch"]
        overhead = p["node"]["overhead_kw"]
        s.airflow = airflow = self._row_airflow()
        alpha = 1 - math.exp(-PHYS_DT / gp["tau_s"])
        single_feed = not all(s.ups.values())
        s.it_kw = 0.0
        for rack in s.racks.values():
            af = airflow[rack.row]
            rack.inlet = s.supply_c + 1.0 + (1 - af) * hall["recirculation_c"]
            r_eff = gp["r_th_c_per_w"] / af**0.7
            # Pass 1: what each GPU would draw unconstrained by the rack feed.
            plan = []  # (gpu, node, inlet, util, f_th, demand)
            for node_id in rack.nodes:
                node = s.nodes[node_id]
                if node.role == "batch" and not node.batch_paused and not node.cordoned:
                    drift = s.rng.gauss(0, 0.015) + 0.02 * (batch["util_mean"] - node.batch_util)
                    node.batch_util = min(batch["util_max"], max(batch["util_min"], node.batch_util + drift))
                util = self._util(node)
                inlet = rack.inlet + node.slot * hall["slot_rise_c"]
                for gi in node.gpus:
                    g = s.gpus[gi]
                    if g.fallen:
                        g.util = g.power = g.clock = 0.0
                        g.throttle = ""
                        g.temp += (inlet - g.temp) * alpha
                        continue
                    f_th = 1.0
                    if g.temp >= gp["slowdown_c"]:
                        f_th = max(0.35, 1 - 0.08 * (g.temp - gp["slowdown_c"]))
                    u = min(1.0, util * (0.97 + 0.06 * s.rng.random())) if util > 0.01 else util
                    demand = gp["idle_w"] + (gp["tdp_w"] - gp["idle_w"]) * u * f_th
                    plan.append((g, node, inlet, u, f_th, demand))
            # Pass 2: on a single feed the BMC water-fills the remaining budget across GPUs.
            feed_cap = None
            if single_feed:
                rack.cap_kw = p["power"]["single_feed_kw"]
                budget = (rack.cap_kw - overhead * len(rack.nodes)) * 1000
                feed_cap = _water_fill([min(d, g.power_limit) for g, *_rest, d in plan], budget)
            else:
                rack.cap_kw = None
            total_w = 0.0
            for g, node, inlet, u, f_th, demand in plan:
                cap = g.power_limit if feed_cap is None else min(g.power_limit, feed_cap)
                f_pw = 1.0
                if demand > cap and u > 0:
                    f_pw = max(0.3, (cap - gp["idle_w"]) / (demand - gp["idle_w"]))
                    demand = cap
                g.power, g.util, g.clock = demand, u, f_th * f_pw
                g.throttle = "thermal" if f_th < 1 else "power" if f_pw < 1 else ""
                if f_th < 1:
                    g.thermal_violation_s += PHYS_DT
                if f_pw < 1:
                    g.power_violation_s += PHYS_DT
                g.temp += (inlet + r_eff * g.power - g.temp) * alpha
                g.fb_used_mb = self._fb_used(node, gp)
                total_w += g.power
                if g.temp >= gp["shutdown_c"] and s.rng.random() < 0.04:
                    self.xid(g, 79, f"thermal shutdown at {g.temp:.0f}°C")
            rack.power_kw = total_w / 1000 + overhead * len(rack.nodes)
            rack.exhaust = rack.inlet + rack.power_kw / (1.2 * 1.005 * hall["rack_airflow_m3s"] * af)
            s.it_kw += rack.power_kw
        capacity = sum(c.capacity_kw for c in s.crahs if c.running)
        mass = hall["thermal_mass_kj_per_c"]
        if s.it_kw > capacity:
            s.supply_c = min(hall["max_supply_c"], s.supply_c + (s.it_kw - capacity) / mass * PHYS_DT)
        else:
            s.supply_c = max(hall["supply_setpoint_c"], s.supply_c - (capacity - s.it_kw) / mass * PHYS_DT)
        running = sum(c.running for c in s.crahs)
        s.cooling_kw = min(s.it_kw, capacity) / hall["cooling_cop"] + hall["crah_fan_kw"] * running
        s.pue = (s.it_kw * (1 + hall["ups_loss_frac"]) + s.cooling_kw) / max(s.it_kw, 1e-6)

    def _fb_used(self, node: Node, gp: dict) -> float:
        if node.cordoned:
            return 0.0
        if node.role == "batch":
            return 0.0 if node.batch_paused else 0.86 * gp["fb_total_mb"]
        w = self.state.workers[node.worker]
        weights = self.profile["inference"]["weights_mb"]
        if w.state in ("ready", "hung"):
            return weights + (gp["fb_total_mb"] - weights - 4000) * min(1.0, w.kv_used / w.kv_capacity + 0.6)
        return weights * 0.5 if w.state == "restarting" else 0.0

    # ------------------------------------------------------------------- KPIs

    def _sample_loop(self):
        while True:
            yield self.env.timeout(SAMPLE_DT)
            s, now = self.state, self.env.now
            horizon = now - 3 * WINDOW_S
            while s.arrivals and s.arrivals[0] < horizon:
                s.arrivals.popleft()
            while s.window and s.window[0][0] < horizon:
                s.window.popleft()
            for w in s.workers.values():
                for q in (w.window, w.tokens):
                    while q and q[0][0] < horizon:
                        q.popleft()
                w.log_rate = max(2.0, w.log_rate * 0.8)
            self._resolve_faults()
            s.series.append(self.kpis())

    def _resolve_faults(self) -> None:
        s = self.state
        for f in s.faults.values():
            if f.get("resolved_at") is not None:
                continue
            kind, targets = f["kind"], f.get("targets", [])
            if kind == "worker_crash":
                done = all(s.workers[t].state == "ready" for t in targets)
            elif kind == "worker_hang":
                done = all(s.workers[t].state != "hung" for t in targets)
            elif kind == "tool_parser":
                done = all(s.workers[t].tool_ok or not self.in_rotation(s.workers[t]) for t in targets)
            elif kind == "traffic_burst":
                done = s.burst == 1.0
            else:
                continue  # infrastructure faults clear only through a field repair
            if done:
                f["resolved_at"] = round(self.env.now, 1)
                self.log("ok", f"resolved: {f['title']}", f.get("target"), "resolved")

    def worker_kpis(self, w: Worker) -> dict:
        cutoff = self.env.now - WINDOW_S
        ttfts, n, err, silent = [], 0, 0, 0
        for t, ttft, _e2e, status in reversed(w.window):
            if t < cutoff:
                break
            n += 1
            if status in FAILED:
                err += 1
            else:
                ttfts.append(ttft)
                silent += status == "silent"
        tokens = sum(tok for t, tok in w.tokens if t >= cutoff)
        return {
            "rps": n / WINDOW_S,
            "ttft_p95": percentile(ttfts, 95),
            "error_rate": err / n if n else 0.0,
            "silent": silent,
            "tps": tokens / WINDOW_S,
        }

    def kpis(self) -> dict:
        s, now = self.state, self.env.now
        cutoff = now - WINDOW_S
        ttfts, tpots, n, failed, tool, silent = [], [], 0, 0, 0, 0
        for t, ttft, status, is_tool, tpot in reversed(s.window):
            if t < cutoff:
                break
            n += 1
            if status in FAILED:
                failed += 1
            else:
                ttfts.append(ttft)
                tpots.append(tpot)
                if is_tool:
                    tool += 1
                    silent += status == "silent"
        tokens = sum(tok for w in s.workers.values() for t, tok in w.tokens if t >= cutoff)
        rotation = [w for w in s.workers.values() if self.in_rotation(w)]
        canary = sum(w.canary_ok for w in rotation) / len(rotation) if rotation else 0.0
        serving = [w for w in rotation if w.state == "ready" and w.healthy]
        live = [g for g in s.gpus if not g.fallen]
        p95 = percentile(ttfts, 95)
        tpot_p95 = percentile(tpots, 95)
        error_rate = failed / n if n else 0.0
        silent_rate = silent / tool if tool else 0.0
        slo = self.profile["slo"]
        return {
            "t": round(now, 1),
            "rps_in": sum(1 for t in s.arrivals if t >= cutoff) / WINDOW_S,
            "ttft_p50": percentile(ttfts, 50),
            "ttft_p95": p95,
            "tpot_p95": tpot_p95,
            "error_rate": error_rate,
            "silent_rate": silent_rate,
            "tps": tokens / WINDOW_S,
            "queue": len(s.queue) + sum(len(w.waiting) for w in s.workers.values()),
            "running": sum(len(w.running) for w in s.workers.values()),
            "canary": canary,
            "capacity": len(serving) / len(s.workers),
            "it_kw": s.it_kw,
            "cooling_kw": s.cooling_kw,
            "pue": s.pue,
            "supply_c": s.supply_c,
            "max_gpu_c": max(g.temp for g in live) if live else 0.0,
            "throttled": sum(1 for g in s.gpus if g.throttle),
            "slo_ok": (p95 is not None and p95 <= slo["ttft_p95_s"])
            and (tpot_p95 is not None and tpot_p95 <= slo["tpot_p95_s"])
            and error_rate <= slo["error_rate"]
            and canary >= 0.999
            and silent_rate < 0.01,
        }
