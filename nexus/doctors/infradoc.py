"""Infrastructure Doctor: process, capacity, network, GPU and facility failures.

Diagnosis is driven only by what the read-only tools observe in telemetry; the
injected fault is never read. Facility and hardware root causes end at
REQUIRES_APPROVAL: the doctor contains the impact but cannot repair cooling,
power or a GPU.
"""

from __future__ import annotations

from nexus.simulator.model import Twin

from . import tools as T
from .base import DoctorRun, sleep

INCIDENTS = {
    "hung_worker": ("Hung worker", "Process health", None, "worker_hang"),
    "crashed_worker": ("Worker crash", "Process health", "VLLM-56943", "worker_crash"),
    "gpu_hardware": ("GPU hardware fault (XID)", "Abstain", "NVIDIA-XID-48-79-94", "gpu_xid"),
    "network_link": ("Degraded network link", "Network", "NETEM-GATEWAY", "network_degrade"),
    "cooling_loss": ("Cooling loss", "Abstain", "DCGM-720", "crah_failure"),
    "power_feed": ("Power feed loss", "Abstain", None, "power_feed_loss"),
    "overload": ("Burst overload", "Capacity", "VLLM-18826", "traffic_burst"),
}
FACILITY = {"gpu_hardware", "cooling_loss", "power_feed"}


class InfrastructureDoctor(DoctorRun):
    doctor = "infra"
    title = "Infrastructure Doctor"
    HYPOTHESES = {k: v[0] for k, v in INCIDENTS.items()}

    def flow(self, twin: Twin):
        self.signature = ["class:infra"] + [f"alarm:{a}" for a in self.signal["alarms"]]
        self.goto(twin, "INGEST", ", ".join(self.signal["alarms"]))
        ok, k = self.call(twin, "query_metrics", T.query_metrics, {"metric": "ttft_p95", "window_s": 60}, "How far from the SLO is the service?")
        self.evidence(twin, "metrics", "gateway", f"Alarms: {', '.join(self.signal['alarms'])}", data={"alarms": self.signal["alarms"], "ttft_p95": k})
        yield sleep(2.0)

        self.goto(twin, "DIAGNOSE", "localize the failing layer")
        ok, workers = self.call(twin, "list_workers", T.list_workers, {}, "Which replicas are unhealthy, stalled or slow?")
        ok, facility = self.call(twin, "inspect_facility", T.inspect_facility, {}, "Check cooling and power before blaming software", "cooling_loss")
        found = self._localize(twin, workers, facility)
        yield sleep(2.5)

        # Context: confirm the leading suspect with a targeted tool.
        self.goto(twin, "EXPAND_CONTEXT", "confirm the leading suspect")
        top, target = found
        if top in ("hung_worker", "crashed_worker"):
            ok, logs = self.call(twin, "read_logs", T.read_logs, {"service": target, "limit": 6}, "Read the engine log of the suspect replica", top)
            node = twin.state.workers[target].node
            ok, gpu = self.call(twin, "inspect_gpu", T.inspect_gpu, {"node": node}, "Rule out a GPU fault under the replica", "gpu_hardware")
            xid = any(gpu["DCGM_FI_DEV_XID_ERRORS"])
            self.evidence(
                twin, "logs", target, (logs["lines"][-1] if logs and logs["lines"] else "no recent log lines"),
                supports=[top], data=logs,
            )
            self.evidence(
                twin, "dcgm", node, "XID present on this node" if xid else "No XID, temperatures normal on this node",
                supports=["gpu_hardware"] if xid else [], contradicts=[] if xid else ["gpu_hardware"], data=gpu,
            )
            if xid:
                top, target = "gpu_hardware", node
        elif top == "gpu_hardware":
            ok, gpu = self.call(twin, "inspect_gpu", T.inspect_gpu, {"node": target}, "Read DCGM fields on the node", top)
            self.evidence(twin, "dcgm", target, f"DCGM_FI_DEV_XID_ERRORS = {max(gpu['DCGM_FI_DEV_XID_ERRORS'])} on {target}", supports=[top], data=gpu)
        elif top == "network_link":
            ok, net = self.call(twin, "inspect_network", T.inspect_network, {"rack": target}, "Measure the top-of-rack link", top)
            self.evidence(twin, "network", target, f"ToR {target}: +{net['tor_latency_ms']} ms, {net['tor_loss_pct']}% loss", supports=[top], data=net)
        elif top in ("cooling_loss", "power_feed"):
            ok, m = self.call(twin, "query_metrics", T.query_metrics, {"metric": "max_gpu_c", "window_s": 120}, "Is heat or power capping reaching the GPUs?", top)
            self.evidence(twin, "dcgm", "fleet", f"Hottest GPU {m['latest']:.0f} °C, {facility['throttled_gpus']} GPUs throttled", supports=[top], data=m)
        elif top == "overload":
            ok, m = self.call(twin, "query_metrics", T.query_metrics, {"metric": "rps_in", "window_s": 60}, "Compare demand with the baseline", top)
            self.evidence(twin, "metrics", "gateway", f"Arrivals {m['latest']:.0f} rps vs ~{twin.profile['traffic']['base_rps']} baseline; queue {twin.state.series[-1]['queue']}", supports=[top], data=m)
        yield sleep(2.0)

        title, klass, candidate, kind = INCIDENTS[top]
        self.incident = {"title": title, "incident_class": klass, "candidate_id": candidate, "target": target, "targets": [target] if target else []}
        self.signature += [f"diagnosis:{top}"]
        self.diagnosis = {"hypothesis": top}
        self.goto(twin, "EXPAND_CONTEXT", "incident memory")
        self.retrieve_context(twin)
        yield sleep(1.5)

        rank = self.ranking()[0]
        self.goto(twin, "DIAGNOSE", "leading hypothesis cites evidence")
        self.diagnosis = {
            "hypothesis": top,
            "confidence": rank["confidence"] if rank["id"] == top else self.hyp[top],
            "evidence": [e["evidence_id"] for e in self.ledger if top in e["supports"]],
            "summary": f"{title}" + (f" on {target}" if target else ""),
        }
        self.emit(twin, "decision", self.diagnosis["summary"], self.diagnosis)
        yield sleep(1.5)

        self.goto(twin, "PLAN", "containment within policy" if top in FACILITY else "bounded repair with rollback")
        if top in FACILITY:
            self.decide(twin, f"repair {title.lower()}", "out of scope", "software cannot repair facility or hardware; contain and escalate")
        incident = {"kind": kind, "target": target, "targets": [target] if target else []}
        self.plan = {"hypothesis_id": top, "incident": incident, "verification_plan": ["tool_call_canary", "hidden_canary", "slo"]}
        self.emit(twin, "plan", "Compare candidate actions in the shadow twin before touching the fleet", self.plan)
        yield sleep(1.5)

        yield from self.precheck_and_act(twin, [incident])
        if self.done:
            return

        def facility_open(tw: Twin) -> str | None:
            if top == "cooling_loss":
                tripped = [c.id for c in tw.state.crahs if not c.running]
                return f"{', '.join(tripped)} tripped" if tripped else None
            if top == "power_feed":
                lost = [u for u, on in tw.state.ups.items() if not on]
                return f"{', '.join(lost)} feed lost" if lost else None
            if top == "gpu_hardware":
                return f"failed GPU on {target}" if any(tw.state.gpus[i].fallen for i in tw.state.nodes[target].gpus) else None
            return None

        yield from self.verify(twin, facility_open=facility_open)

    def _localize(self, twin: Twin, workers: list[dict], facility: dict) -> tuple[str, str | None]:
        """Rank suspects from what list_workers and inspect_facility returned."""
        s = twin.state
        suspects: list[tuple[str, str | None, str]] = []
        tripped = [c for c, v in facility["crah"].items() if v != "running"]
        lost = [u for u, v in facility["ups"].items() if v != "online"]
        if tripped:
            suspects.append(("cooling_loss", tripped[0], f"{tripped[0]} tripped; supply air {facility['supply_air_c']} °C"))
        if lost:
            suspects.append(("power_feed", lost[0], f"{lost[0]} feed lost; racks on a single feed"))
        xid_nodes = [n.id for n in s.nodes.values() if any(s.gpus[i].xid for i in n.gpus) and not n.cordoned]
        if xid_nodes:
            suspects.append(("gpu_hardware", xid_nodes[0], f"XID reported on {xid_nodes[0]}"))
        for w in workers:
            if not w["in_rotation"]:
                continue
            if w["health"] != "200":
                suspects.append(("crashed_worker", w["service"], f"{w['service']} fails health checks"))
            elif w["tokens_per_s"] == 0 and w["waiting"] > 0:
                suspects.append(("hung_worker", w["service"], f"{w['service']} answers /health but produced 0 tokens/s with {w['waiting']} waiting"))
        slow = [w for w in workers if w["in_rotation"] and w["canary"] == "fail" and w["health"] == "200" and w["tokens_per_s"] > 0]
        if slow:
            rack = s.nodes[s.workers[slow[0]["service"]].node].rack
            suspects.append(("network_link", rack, f"{', '.join(w['service'] for w in slow)} on rack {rack} serve slowly and fail canaries"))
        k = s.series[-1]
        if k["rps_in"] > 1.8 * twin.profile["traffic"]["base_rps"]:
            suspects.append(("overload", None, f"arrivals {k['rps_in']:.0f} rps, queue {k['queue']}"))
        if not suspects:
            suspects.append(("overload", None, "SLO breach without a localized fault"))
        order = ["cooling_loss", "power_feed", "gpu_hardware", "crashed_worker", "hung_worker", "network_link", "overload"]
        suspects.sort(key=lambda x: order.index(x[0]))
        top, target, why = suspects[0]
        others = {x[0] for x in suspects[1:]}
        self.evidence(
            twin, "telemetry", "list_workers + inspect_facility", why,
            supports=[top], contradicts=[h for h in self.HYPOTHESES if h != top and h not in others],
            data={"suspects": [{"hypothesis": h, "target": t, "why": y} for h, t, y in suspects]},
        )
        return top, target
