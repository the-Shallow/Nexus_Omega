"""Produce the E1 context-expansion handoff from the live fleet (E1.md sections 6-7).

Resets the target worker to its healthy profile, captures the visible canary,
launch config, trace, raw generation and bounded logs; injects VLLM-32926 and
captures the same; repeats; then restores the healthy profile. Output shapes
follow E1.md. The other worker keeps serving throughout.

Raw generation: vLLM does not expose a request's pre-parser text, so it is the
identical rendered prompt replayed through /tokenize + /v1/completions at
temperature 0 (labelled capture="deterministic_replay").

Usage:
    python -m nexus.harness.handoff --service target-a --runs 3
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import uuid
from pathlib import Path

import httpx

from nexus.harness.inspect import bounded_logs, effective_launch_config, worker_for
from nexus.target import manager
from nexus.verifier import canary

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts" / "brev-context-expansion"
HEALTHY = "qwen25-coder-7b.tools-template"
BROKEN = "qwen25-coder-7b.vllm-32926"
VISIBLE_CASE = next(c for c in canary.BUILTIN_CASES if c["name"] == "single_call")


def visible_canary(worker: str) -> dict:
    state = manager.read_state(worker)
    profile = manager.load_profile(state["profile"])
    base = f"http://localhost:{state['port']}"
    with httpx.Client(timeout=120) as client:
        result = canary.run_case(client, base, profile["served_model_name"], VISIBLE_CASE,
                                 raw=True, no_think=True)
        readiness = canary.health(client, base)
    request_id = f"req-{uuid.uuid4().hex[:8]}"
    raw = result.get("raw_generation", {})
    content = result.get("content") or ""
    return {
        "canary": {"case": "visible_tool_call", "request_id": request_id,
                   "http_status": result["http_status"], "readiness": readiness,
                   "parsed_tool_call_count": len(result["tool_calls"]),
                   "structured_response": {"content": content or None, "tool_calls": result["tool_calls"]}},
        "trace": {"request_id": request_id, "http_status": result["http_status"],
                  "structured_response": {"tool_calls": result["tool_calls"]},
                  "parser_result": f"{len(result['tool_calls'])} tool calls",
                  "canary_verdict": result["reason"]},
        "raw": {"request_id": request_id, "text": raw.get("text", ""),
                "capture": "deterministic_replay", "available": raw.get("available", False),
                "matches_structured_content": bool(content) and raw.get("text", "").strip() == content.strip()},
    }


def capture(service: str, worker: str, profile: str) -> dict:
    manager.apply(worker, profile)
    observed = visible_canary(worker)
    return {**observed, "launch_config": effective_launch_config(service),
            "logs": bounded_logs(service, "5m", "tool|parser|template|ERROR", 50)}


def environment() -> str:
    def sh(*cmd: str) -> str:
        return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
    # The Brev copy is synced with rsync and has no .git; the sync step passes the local HEAD.
    sha = os.environ.get("NEXUS_COMMIT") or "(not recorded; set NEXUS_COMMIT when syncing)"
    return "\n".join([
        "# Brev environment", "",
        f"- repository commit: {sha}",
        f"- GPU: {sh('nvidia-smi', '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader')}",
        f"- Python: {platform.python_version()}",
        f"- Docker: {sh('docker', 'version', '--format', '{{.Server.Version}}')}",
        f"- vLLM image: {manager.DEFAULT_IMAGE}",
        "",
    ])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.harness.handoff")
    parser.add_argument("--service", default="target-a")
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args(argv)
    worker = worker_for(args.service)
    OUT.mkdir(parents=True, exist_ok=True)

    runs = []
    try:
        for i in range(args.runs):
            healthy = capture(args.service, worker, HEALTHY)
            broken = capture(args.service, worker, BROKEN)
            runs.append({"run": i + 1, "healthy": healthy, "broken": broken,
                         "matched": healthy["canary"]["parsed_tool_call_count"] > 0
                         and broken["canary"]["http_status"] == 200
                         and broken["canary"]["parsed_tool_call_count"] == 0
                         and "get_weather" in broken["raw"]["text"]})
            print(f"run {i + 1}: matched={runs[-1]['matched']}")
    finally:
        manager.apply(worker, HEALTHY)

    last = runs[-1]
    files = {
        "healthy-canary.json": last["healthy"]["canary"],
        "broken-canary.json": last["broken"]["canary"],
        "launch-config.json": {"healthy": last["healthy"]["launch_config"],
                               "broken": last["broken"]["launch_config"]},
        "request-trace.json": last["broken"]["trace"],
        "raw-generation.json": last["broken"]["raw"],
        "bounded-logs.json": last["broken"]["logs"],
        "runs.json": runs,
    }
    for name, content in files.items():
        (OUT / name).write_text(json.dumps(content, indent=2) + "\n")
    (OUT / "environment.md").write_text(environment())
    (OUT / "reproduction.md").write_text("\n".join([
        "# Reproduction", "",
        f"- service: {args.service} (container {manager.container_name(worker)})",
        f"- reset: `python3 -m nexus.target.manager apply {worker} {HEALTHY}`",
        f"- inject: `python3 -m nexus.target.manager apply {worker} {BROKEN}`",
        "- change between states: only the parser/template pair (hermes + model default template "
        "vs qwen2_5_coder plugin + <tools> template)",
        f"- runs: {len(runs)}, all matched: {all(r['matched'] for r in runs)}",
        "- raw generation: deterministic replay of the identical rendered prompt at temperature 0",
        "",
    ]))
    print(f"handoff written to {OUT}")
    return 0 if all(r["matched"] for r in runs) else 1


if __name__ == "__main__":
    sys.exit(main())
