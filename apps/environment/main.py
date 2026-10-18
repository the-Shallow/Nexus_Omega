"""Brev environment API: the live fleet as a manifest-driven environment.

The agent's HttpEnvironmentProvider calls the eight read routes with
NEXUS_ENVIRONMENT_API_KEY. Everything it can see or propose is declared in the
manifest from GET /environment; anything undeclared is rejected. The only
route that changes the fleet, POST /actions/{action_id}/apply, needs a
different key, NEXUS_EXECUTOR_TOKEN, held by the runner and never by the
agent's HTTP client. It goes through nexus.harness.executor (lock, last-worker
guard, drain -> change -> hidden canary -> undrain or roll back, audit).

Run on the Brev host: scripts/environment_up.sh (127.0.0.1:8120).
"""
from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from collections import OrderedDict

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from nexus.harness import executor, incident
from nexus.harness.inspect import (TARGET_WORKERS, HarnessError, bounded_logs, effective_launch_config,
                                   parse_vllm_args)
from nexus.target import manager
from nexus.verifier import canary, route

API_KEY = os.environ.get("NEXUS_ENVIRONMENT_API_KEY", "")
EXECUTOR_TOKEN = os.environ.get("NEXUS_EXECUTOR_TOKEN", "")
PROMETHEUS = os.environ.get("NEXUS_PROMETHEUS_URL", "http://localhost:9090")
RESOURCES = tuple(f"target-{w}" for w in TARGET_WORKERS)
# No profile names: a worker's profile label (e.g. "qwen25-coder-7b.vllm-32926")
# names the injected fault, so exposing it would hand the agent the answer.
# It must diagnose from the effective parser, template and outputs instead.
CONFIG_KEYS = ("tool_call_parser", "chat_template", "enable_auto_tool_choice", "tool_parser_plugin",
               "reasoning_parser", "model", "model_revision", "image_digest", "container_state",
               "max_num_seqs", "gpu_memory_utilization", "max_model_len")
STATE_FIELDS = ("container", "ready", "drained", "weight", "active_requests", "queued_requests", "port",
                "container_state", "serving")
FAULT_CLASSES = {
    "none": "healthy: no evidence of a problem",
    "misconfigured": "the worker's serving configuration differs from the reviewed one (parser, template, flags, limits)",
    "crashed": "the worker process is not running or not answering",
    "network_path": "the worker behaves normally when reached directly but not through the entry point",
    "overloaded": "the worker itself is slow under its load while its configuration matches the reviewed one",
    "unknown": "abnormal, but the evidence does not identify a cause",
}
WINDOW_RE = re.compile(r"^([1-9][0-9]?)([sm])$")
# metric -> (PromQL with {window} and {label}, label name, label value pattern, unit)
METRICS = {
    "ttft_p95_s": ('histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket'
                   '{{instance="{label}"}}[{window}])))', "instance", "nexus-{w}:8000", "seconds"),
    "queue_waiting": ('max_over_time(vllm:num_requests_waiting{{instance="{label}"}}[{window}])',
                      "instance", "nexus-{w}:8000", "requests"),
    "kv_cache_usage": ('max_over_time(vllm:kv_cache_usage_perc{{instance="{label}"}}[{window}])',
                       "instance", "nexus-{w}:8000", "fraction"),
    "route_latency_avg_s": ('max_over_time(haproxy_server_total_time_average_seconds'
                            '{{proxy="vllm",server="{label}"}}[{window}])', "server", "{w}", "seconds"),
    "route_error_rate": ('(sum(rate(haproxy_server_connection_errors_total{{proxy="vllm",server="{label}"}}[{window}]))'
                         ' + sum(rate(haproxy_server_response_errors_total{{proxy="vllm",server="{label}"}}[{window}]))'
                         ' + sum(rate(haproxy_server_http_responses_total{{proxy="vllm",server="{label}",code="5xx"}}[{window}])))'
                         ' / sum(rate(haproxy_server_sessions_total{{proxy="vllm",server="{label}"}}[{window}]))',
                         "server", "{w}", "fraction"),
}
ARTIFACT_SECTIONS = ("structured_response", "request_trace", "raw_generation")
VISIBLE_CASE = next(c for c in canary.BUILTIN_CASES if c["name"] == "single_call")
ARTIFACTS: OrderedDict[str, dict] = OrderedDict()
MAX_ARTIFACTS = 200


def healthy_profiles() -> list[str]:
    names = []
    for path in sorted(manager.PROFILES_DIR.glob("*.json")):
        if json.loads(path.read_text()).get("kind") == "healthy" and path.stem.startswith("qwen25-coder"):
            names.append(path.stem)
    return names


def build_manifest() -> dict:
    empty = {"type": "object", "properties": {}, "additionalProperties": False}
    before = ["tool_call_parser", "chat_template", "enable_auto_tool_choice", "tool_parser_plugin"]
    return {
        "id": "nexus-brev-fleet",
        # Traffic paths are stated as plain facts. An earlier wording ("a network proxy that can be
        # impaired") steered the agent to call a worker-side capacity fault a network fault.
        "description": ("Two vLLM workers serving Qwen2.5-Coder-7B behind HAProxy on one H100. "
                        "HAProxy reaches target-a directly and target-b through a TCP proxy."),
        "fault_classes": FAULT_CLASSES,
        "resources": [{
            "id": r, "kind": "inference-service",
            "description": f"vLLM worker {r.removeprefix('target-')} behind the HAProxy entry point.",
            "configuration_keys": list(CONFIG_KEYS), "metrics": list(METRICS),
        } for r in RESOURCES],
        "probes": [
            {"id": "tool-call-visible",
             "description": ("Send one visible request that should produce a structured tool call, "
                             "directly to one worker. Returns an artifact_id for its trace and raw generation."),
             "inputs": {"type": "object", "additionalProperties": False, "required": ["case", "resource_id"],
                        "properties": {"case": {"type": "string", "enum": ["visible_tool_call"]},
                                       "resource_id": {"type": "string", "enum": list(RESOURCES)}}}},
            {"id": "config-diff",
             "description": ("Compare each worker's effective launch configuration with the reviewed "
                             "configuration and return, per worker, only the keys that differ from it (actual "
                             "vs reviewed). Also lists keys that differ between the workers."),
             "inputs": {"type": "object", "additionalProperties": False, "properties": {}}},
            {"id": "path-compare",
             "description": ("For each worker, measure latency and errors directly on the worker and through "
                             "the HAProxy entry point, side by side. Slow or failing on both paths points at "
                             "the worker; only through HAProxy points at the path to it."),
             "inputs": {"type": "object", "additionalProperties": False, "required": ["requests"],
                        "properties": {"requests": {"type": "integer", "minimum": 5, "maximum": 20}}}},
            {"id": "route-probe",
             "description": ("Send small requests through the HAProxy entry point and report p95 latency "
                             "and error rate per worker, as users see them."),
             "inputs": {"type": "object", "additionalProperties": False, "required": ["requests"],
                        "properties": {"requests": {"type": "integer", "minimum": 5, "maximum": 30}}}},
        ],
        "actions": [
            {"id": "apply-serving-profile",
             "description": ("Relaunch a worker with a reviewed serving profile (model, parser, chat template, "
                             "flags and limits). Repairs a worker whose configuration differs from the "
                             "reviewed one. Takes the worker out of rotation while it restarts."),
             "addresses": ["misconfigured"], "removes_capacity": True,
             "allowed_targets": list(RESOURCES),
             "parameters": {"type": "object", "additionalProperties": False, "required": ["profile"],
                            "properties": {"profile": {"type": "string", "enum": healthy_profiles()}}},
             "before_state_keys": before, "automatic": True, "requires_rollback": True},
            {"id": "drain-worker",
             "description": ("Stop routing new traffic to a worker. Mitigates a fault that software cannot "
                             "repair (the path to the worker, or load it cannot carry); the cause still needs "
                             "a human. Refused if no other worker is serving."),
             "addresses": ["network_path", "overloaded"], "removes_capacity": True, "restores_service": False,
             "allowed_targets": list(RESOURCES), "parameters": empty,
             "before_state_keys": ["container_state", "tool_call_parser"], "automatic": True, "requires_rollback": True},
            {"id": "restart-worker",
             "description": ("Relaunch a worker with its current profile. Repairs a crashed or hung worker; "
                             "does not change its configuration. Takes the worker out of rotation while it "
                             "restarts."),
             "addresses": ["crashed"], "removes_capacity": True,
             "allowed_targets": list(RESOURCES), "parameters": empty,
             "before_state_keys": ["container_state", "tool_call_parser"], "automatic": True, "requires_rollback": True},
            {"id": "undrain-worker",
             "description": "Return a drained worker to rotation.",
             "allowed_targets": list(RESOURCES), "parameters": empty,
             "before_state_keys": ["container_state"], "automatic": False, "requires_rollback": True},
        ],
        "artifact_sections": list(ARTIFACT_SECTIONS),
        "verifiers": ["tool-call-hidden", "route-probe"],
    }


MANIFEST = build_manifest()
ACTIONS = {a["id"]: a for a in MANIFEST["actions"]}
app = FastAPI(title="Nexus Ω Brev environment")


def bearer(request: Request, expected: str) -> None:
    if expected and request.headers.get("authorization") != f"Bearer {expected}":
        raise HTTPException(401, "missing or invalid token")


def require_read(request: Request) -> None:
    bearer(request, API_KEY)


def require_executor(request: Request) -> None:
    if not EXECUTOR_TOKEN:
        raise HTTPException(503, "NEXUS_EXECUTOR_TOKEN is not configured")
    bearer(request, EXECUTOR_TOKEN)


def resource(resource_id: str) -> str:
    if resource_id not in RESOURCES:
        raise HTTPException(404, f"undeclared resource: {resource_id}")
    return resource_id.removeprefix("target-")


def window(value: str) -> str:
    match = WINDOW_RE.match(value)
    if not match or (match.group(2) == "m" and int(match.group(1)) > 60):
        raise HTTPException(400, "window must look like 30s or 5m (at most 60m)")
    return value


def direct_latency(port: int, n: int) -> dict:
    """p95 latency and error rate of n small requests sent straight to one worker."""
    body = {"model": "qwen25-coder", "messages": [{"role": "user", "content": "Reply with the word ok."}],
            "max_tokens": 8, "temperature": 0}
    latencies, errors = [], 0
    with httpx.Client(timeout=15) as client:
        for _ in range(n):
            started = time.monotonic()
            try:
                ok = client.post(f"http://localhost:{port}/v1/chat/completions", json=body).status_code == 200
            except httpx.HTTPError:
                ok = False
            latencies.append(time.monotonic() - started)
            errors += not ok
    return {"p95_s": round(route.p95(latencies), 3), "error_rate": round(errors / n, 3), "requests": n}


def remember(artifact: dict) -> str:
    artifact_id = f"art-{uuid.uuid4().hex[:10]}"
    ARTIFACTS[artifact_id] = artifact
    while len(ARTIFACTS) > MAX_ARTIFACTS:
        ARTIFACTS.popitem(last=False)
    return artifact_id


@app.get("/environment", dependencies=[Depends(require_read)])
def describe_environment():
    return MANIFEST


@app.get("/resources", dependencies=[Depends(require_read)])
def list_resources():
    rows = {r["worker"]: r for r in manager.status()}
    return {"resources": [{"id": r, "kind": "inference-service",
                           "container": rows.get(r.removeprefix("target-"), {}).get("container", "missing")}
                          for r in RESOURCES]}


class FieldsBody(BaseModel):
    fields: list[str] = Field(min_length=1, max_length=20)


@app.post("/resources/{resource_id}/state", dependencies=[Depends(require_read)])
def get_resource_state(resource_id: str, body: FieldsBody):
    # The manifest format has no list of state fields, so the agent may guess
    # names. Answer what is known and name the rest rather than failing the call.
    worker = resource(resource_id)
    row = next((r for r in manager.status() if r["worker"] == worker), {})
    routes = executor.gateway("GET", "/admin/workers").get(worker, {})
    try:
        ready = httpx.get(f"http://localhost:{row.get('port')}/health", timeout=5).status_code == 200
    except httpx.HTTPError:
        ready = False
    full = {"container": row.get("container", "missing"), "ready": ready, "drained": routes.get("drained"),
            "weight": routes.get("weight"), "active_requests": routes.get("active"),
            "queued_requests": routes.get("queued"), "port": row.get("port"),
            "container_state": row.get("container", "missing"),
            "serving": row.get("container") == "running" and ready and not routes.get("drained", True)}
    unknown = [f for f in body.fields if f not in full]
    return {"resource_id": resource_id, "state": {k: full[k] for k in body.fields if k in full},
            "unavailable_fields": unknown, "available_fields": list(STATE_FIELDS) if unknown else None}


class KeysBody(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=20)


@app.post("/resources/{resource_id}/configuration", dependencies=[Depends(require_read)])
def get_configuration(resource_id: str, body: KeysBody):
    resource(resource_id)
    unknown = [k for k in body.keys if k not in CONFIG_KEYS]
    try:
        config = effective_launch_config(resource_id)
    except HarnessError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"resource_id": resource_id, "source": config["source"],
            "configuration": {k: config.get(k) for k in body.keys if k in CONFIG_KEYS},
            "unavailable_keys": unknown, "available_keys": list(CONFIG_KEYS) if unknown else None}


class LogsBody(BaseModel):
    resource_id: str
    since: str
    query: str = ""
    limit: int = Field(ge=1, le=200)


@app.post("/logs/query", dependencies=[Depends(require_read)])
def query_logs(body: LogsBody):
    resource(body.resource_id)
    try:
        since, clamped = incident.clamp_since(body.since)
        out = bounded_logs(body.resource_id, since, body.query, body.limit)
    except HarnessError as exc:
        raise HTTPException(400, str(exc)) from exc
    note = {"note": f"since limited to the start of the current incident ({since})"} if clamped else {}
    return {"resource_id": body.resource_id, **{k: v for k, v in out.items() if k != "service"}, **note}


class MetricBody(BaseModel):
    resource_id: str
    metric: str
    window: str


@app.post("/metrics/query", dependencies=[Depends(require_read)])
def query_metrics(body: MetricBody):
    worker = resource(body.resource_id)
    if body.metric not in METRICS:
        raise HTTPException(404, f"undeclared metric: {body.metric}")
    promql, _, label, unit = METRICS[body.metric]
    applied, clamped = incident.clamp_window(window(body.window))
    query = promql.format(window=applied, label=label.format(w=worker))
    resp = httpx.get(f"{PROMETHEUS}/api/v1/query", params={"query": query}, timeout=10)
    resp.raise_for_status()
    result = resp.json()["data"]["result"]
    value = float(result[0]["value"][1]) if result else math.nan
    notes = ["no samples in window (no traffic or not scraping)"] if math.isnan(value) else []
    if clamped:
        notes.append(f"window limited to the current incident ({applied})")
    return {"resource_id": body.resource_id, "metric": body.metric, "window": body.window,
            "window_applied": applied, "unit": unit, "value": None if math.isnan(value) else round(value, 4),
            "note": "; ".join(notes) or None}


class ProbeBody(BaseModel):
    inputs: dict


@app.post("/probes/{probe_id}/run", dependencies=[Depends(require_read)])
def run_probe(probe_id: str, body: ProbeBody):
    if probe_id == "tool-call-visible":
        if body.inputs.get("case") != "visible_tool_call":
            raise HTTPException(400, "case must be visible_tool_call")
        resource_id = body.inputs.get("resource_id", "target-a")
        worker = resource(resource_id)
        state = manager.read_state(worker)
        model = manager.load_profile(state["profile"]).get("served_model_name")
        with httpx.Client(timeout=120) as client:
            result = canary.run_case(client, f"http://localhost:{state['port']}", model, VISIBLE_CASE,
                                     raw=True, no_think=True)
        raw = result.get("raw_generation") or {}
        artifact_id = remember({
            "structured_response": {"http_status": result["http_status"], "content": result.get("content"),
                                    "tool_calls": result["tool_calls"]},
            "request_trace": {"resource_id": resource_id, "case": "visible_tool_call",
                              "http_status": result["http_status"], "latency_s": result["latency_s"],
                              "parsed_tool_call_count": len(result["tool_calls"]),
                              "request": {"messages": VISIBLE_CASE["messages"],
                                          "tools": [t["function"]["name"] for t in VISIBLE_CASE["tools"]]}},
            "raw_generation": {"text": raw.get("text", ""), "available": raw.get("available", False),
                               "capture": "deterministic_replay"},
        })
        out = {"probe_id": probe_id, "observation_id": artifact_id, "artifact_id": artifact_id,
               "resource_id": resource_id, "http_status": result["http_status"],
               "structured_tool_call_count": len(result["tool_calls"]), "verdict": result["reason"]}
        if not result.get("ok", result["http_status"] == 200 and bool(result["tool_calls"])):
            out["flags"] = {resource_id: [f"visible tool-call canary failed: HTTP {result['http_status']}, "
                                          f"{len(result['tool_calls'])} structured tool calls ({result['reason']})"]}
        return out
    if probe_id == "config-diff":
        # Compared with the reviewed profile, not only worker against worker: with two workers a
        # difference alone does not say which one is wrong (held-out v1: the agent blamed the
        # correctly configured worker). The reviewed values go through the same launch-argument
        # builder and parser as the running containers, so the formats match exactly.
        compared = [k for k in CONFIG_KEYS if k not in ("container_state", "image_digest")]
        reviewed = parse_vllm_args(manager.vllm_args(manager.load_profile(healthy_profiles()[0])))
        configs = {}
        for resource_id in RESOURCES:
            try:
                config = effective_launch_config(resource_id)
            except HarnessError as exc:
                configs[resource_id] = {"unavailable": str(exc)}
                continue
            configs[resource_id] = {k: config.get(k) for k in CONFIG_KEYS if k != "container_state"}
        keys = sorted({k for c in configs.values() for k in c if k != "unavailable"})
        differing = {k: {r: c.get(k) for r, c in configs.items()} for k in keys
                     if len({json.dumps(c.get(k)) for c in configs.values()}) > 1}
        versus_reviewed = {
            r: {"matches_reviewed": not diff, "differs_from_reviewed": diff}
            for r, c in configs.items() if "unavailable" not in c
            for diff in [{k: {"actual": c.get(k), "reviewed": reviewed.get(k)} for k in compared
                          if c.get(k) != reviewed.get(k)}]}
        flags = {r: [f"configuration differs from the reviewed one on {sorted(v['differs_from_reviewed'])}"]
                 for r, v in versus_reviewed.items() if not v["matches_reviewed"]}
        flags.update({r: [f"configuration unavailable: {c['unavailable']}"]
                      for r, c in configs.items() if "unavailable" in c})
        return {"probe_id": probe_id, "observation_id": f"config-diff-{uuid.uuid4().hex[:8]}",
                "versus_reviewed": versus_reviewed, "between_workers": differing,
                "unavailable": {r: c["unavailable"] for r, c in configs.items() if "unavailable" in c},
                "flags": flags}
    if probe_id == "path-compare":
        n = body.inputs.get("requests")
        if not isinstance(n, int) or not 5 <= n <= 20:
            raise HTTPException(400, "requests must be an integer from 5 to 20")
        entry = route.run(executor.GATEWAY, "qwen25-coder", 2 * n, 0.5, 0.0)["workers"]
        drained = executor.gateway("GET", "/admin/workers")
        workers = {}
        for resource_id in RESOURCES:
            worker = resource(resource_id)
            direct = direct_latency(manager.read_state(worker)["port"], n)
            via = entry.get(worker)
            workers[resource_id] = {
                "direct": direct,
                "through_haproxy": ({"p95_s": via["p95_s"], "error_rate": via["error_rate"],
                                     "requests": via["requests"]} if via else
                                    {"requests": 0, "note": "drained" if drained.get(worker, {}).get("drained")
                                     else "no requests reached this worker"})}
        flags = {}
        for resource_id, w in workers.items():
            reasons = [f"{path}: p95 {m['p95_s']} s, error rate {m['error_rate']}"
                       for path, m in (("direct", w["direct"]), ("through HAProxy", w["through_haproxy"]))
                       if m.get("requests") and (m["p95_s"] > 0.5 or m["error_rate"] > 0)]
            if reasons:
                flags[resource_id] = reasons
        return {"probe_id": probe_id, "observation_id": f"path-compare-{uuid.uuid4().hex[:8]}",
                "workers": workers, "limits": {"max_p95_s": 0.5, "max_error_rate": 0.0}, "flags": flags}
    if probe_id == "route-probe":
        n = body.inputs.get("requests")
        if not isinstance(n, int) or not 5 <= n <= 30:
            raise HTTPException(400, "requests must be an integer from 5 to 30")
        out = route.run(executor.GATEWAY, "qwen25-coder", n, 0.5, 0.0)
        return {"probe_id": probe_id, "observation_id": f"route-{uuid.uuid4().hex[:8]}",
                "entry_point_health": out["health_status"],
                "workers": {f"target-{w}": v for w, v in out["workers"].items()},
                "limits": out["limits"],
                "flags": {f"target-{w}": [f"through HAProxy: p95 {v['p95_s']} s, error rate {v['error_rate']}"]
                          for w, v in out["workers"].items() if not v["ok"] and f"target-{w}" in RESOURCES}}
    raise HTTPException(404, f"undeclared probe: {probe_id}")


class ArtifactBody(BaseModel):
    artifact_id: str
    section: str


@app.post("/artifacts/read", dependencies=[Depends(require_read)])
def read_artifact(body: ArtifactBody):
    if body.section not in ARTIFACT_SECTIONS:
        raise HTTPException(404, f"undeclared artifact section: {body.section}")
    if body.artifact_id not in ARTIFACTS:
        raise HTTPException(404, f"unknown artifact: {body.artifact_id}")
    return {"artifact_id": body.artifact_id, "section": body.section,
            "content": ARTIFACTS[body.artifact_id][body.section]}


class ApplyBody(BaseModel):
    target: str
    parameters: dict = {}
    change_id: str = ""


@app.post("/actions/{action_id}/apply", dependencies=[Depends(require_executor)])
def apply_action(action_id: str, body: ApplyBody):
    """Not part of the agent's provider: called by the runner after PRECHECK."""
    if action_id not in ACTIONS:
        raise HTTPException(404, f"undeclared action: {action_id}")
    if body.target not in ACTIONS[action_id]["allowed_targets"]:
        raise HTTPException(403, f"target {body.target} not allowed for {action_id}")
    if action_id == "apply-serving-profile":
        profile = body.parameters.get("profile")
        if profile not in ACTIONS[action_id]["parameters"]["properties"]["profile"]["enum"]:
            raise HTTPException(403, f"profile not approved: {profile}")
        record = executor.patch_serving_config(body.target, profile)
    elif action_id == "drain-worker":
        record = executor.drain_worker(body.target)
    elif action_id == "restart-worker":
        record = executor.restart_worker(body.target)
    else:
        record = executor.undrain_worker(body.target)
    return {"action_id": action_id, "change_id": body.change_id, "executor": record}


@app.get("/health")
def health():
    return {"ok": True}
