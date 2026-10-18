"""Read-only views of a running target worker, for the agent's diagnostic backend.

effective_launch_config() reports what the container is actually running
(from `docker inspect`), not what a profile intends. bounded_logs() returns a
capped, filtered, redacted slice of the container log. Neither returns the
process environment. Service IDs are "target-<worker>", e.g. target-a.

Usage:
    python -m nexus.harness.inspect config target-a
    python -m nexus.harness.inspect logs target-a --since 10m --pattern "parser|tool" --limit 50
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

from nexus.target import manager

SERVICE_PREFIX = "target-"
# Repairable target workers. The agent's own server (worker "agent") is never a target.
TARGET_WORKERS = ("a", "b")
MAX_LOG_LINES = 200
MAX_LINE_CHARS = 500
SINCE_RE = re.compile(r"^([1-9][0-9]{0,3})([smh])$")
SECRET_PATTERNS = [
    re.compile(r"hf_[A-Za-z0-9]{8,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)((?:api[_-]?key|token|password|secret)[\"']?\s*[=:]\s*)[\"']?[^\s,\"']+"),
]
# vLLM flags reported as named fields; every other flag stays in "args".
FIELD_FLAGS = {
    "--model": "model",
    "--served-model-name": "served_model_name",
    "--revision": "model_revision",
    "--tool-call-parser": "tool_call_parser",
    "--tool-parser-plugin": "tool_parser_plugin",
    "--chat-template": "chat_template",
    "--reasoning-parser": "reasoning_parser",
    "--gpu-memory-utilization": "gpu_memory_utilization",
    "--max-model-len": "max_model_len",
}


class HarnessError(ValueError):
    """A request outside what the harness allows; safe to show to the agent."""


def worker_for(service: str) -> str:
    worker = service.removeprefix(SERVICE_PREFIX)
    if (not service.startswith(SERVICE_PREFIX) or worker not in TARGET_WORKERS
            or manager.read_state(worker) is None):
        raise HarnessError(f"unknown service: {service}")
    return worker


def redact(text: str) -> str:
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(lambda m: (m.group(1) if m.groups() else "") + "<redacted>", text)
    return text


def docker_json(*args: str) -> dict:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise HarnessError(f"docker {args[0]} failed: {redact(result.stderr.strip())[:200]}")
    return json.loads(result.stdout)[0]


def parse_vllm_args(args: list[str]) -> dict:
    fields = {"enable_auto_tool_choice": "--enable-auto-tool-choice" in args,
              "chat_template": "model default"}
    for i, arg in enumerate(args):
        if arg in FIELD_FLAGS and i + 1 < len(args):
            fields[FIELD_FLAGS[arg]] = args[i + 1]
    return fields


def effective_launch_config(service: str) -> dict:
    worker = worker_for(service)
    container = docker_json("inspect", manager.container_name(worker))
    image = docker_json("image", "inspect", container["Image"])
    args = container.get("Args") or []
    return {
        "service": service,
        "container": manager.container_name(worker),
        "container_state": container["State"]["Status"],
        "image": container["Config"]["Image"],
        "image_digest": (image.get("RepoDigests") or [container["Image"]])[0].split("@")[-1],
        "profile_label": container["Config"].get("Labels", {}).get("nexus.profile"),
        **parse_vllm_args(args),
        "args": [redact(a) for a in args],
        "source": "docker inspect (running container)",
    }


def bounded_logs(service: str, since: str, pattern: str, limit: int) -> dict:
    worker = worker_for(service)
    if not SINCE_RE.match(since):
        raise HarnessError("since must look like 30s, 10m or 2h")
    if not 1 <= limit <= MAX_LOG_LINES:
        raise HarnessError(f"limit must be between 1 and {MAX_LOG_LINES}")
    if len(pattern) > 200:
        raise HarnessError("pattern is too long")
    try:
        matcher = re.compile(pattern) if pattern else None
    except re.error as exc:
        raise HarnessError(f"invalid pattern: {exc}") from exc
    result = subprocess.run(["docker", "logs", "--since", since, manager.container_name(worker)],
                            capture_output=True, text=True, timeout=15)
    lines = (result.stdout + result.stderr).splitlines()
    matched = [line for line in lines if matcher is None or matcher.search(line)]
    kept = matched[-limit:]
    return {
        "service": service,
        "since": since,
        "pattern": pattern,
        "limit": limit,
        "lines": [redact(line)[:MAX_LINE_CHARS] for line in kept],
        "matched_lines": len(matched),
        "truncated": len(matched) > len(kept),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.harness.inspect")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_cfg = sub.add_parser("config")
    p_cfg.add_argument("service")
    p_logs = sub.add_parser("logs")
    p_logs.add_argument("service")
    p_logs.add_argument("--since", default="10m")
    p_logs.add_argument("--pattern", default="")
    p_logs.add_argument("--limit", type=int, default=50)
    args = parser.parse_args(argv)
    if args.cmd == "config":
        out = effective_launch_config(args.service)
    else:
        out = bounded_logs(args.service, args.since, args.pattern, args.limit)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
