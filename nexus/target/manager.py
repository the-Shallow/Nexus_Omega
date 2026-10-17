"""Launch, reconfigure, and roll back vLLM target workers from serving profiles.

A serving profile is a JSON file in runtime/profiles/. Each worker runs as one
Docker container named ``nexus-<worker>`` on the ``nexus`` network. Applying a
profile records the previous one so the change can be rolled back by change ID.

Usage (on the GPU host):
    python -m nexus.target.manager up a qwen3-4b.healthy --port 8101
    python -m nexus.target.manager apply a qwen3-4b.wrong-parser
    python -m nexus.target.manager rollback a <change_id>
    python -m nexus.target.manager status
    python -m nexus.target.manager down a
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
PROFILES_DIR = ROOT / "runtime" / "profiles"
TEMPLATES_DIR = ROOT / "runtime" / "templates"
STATE_DIR = ROOT / "runtime" / "state"

NETWORK = os.environ.get("NEXUS_NETWORK", "nexus")
DEFAULT_IMAGE = os.environ.get("NEXUS_VLLM_IMAGE", "vllm/vllm-openai:v0.27.1")
HF_HOME = os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface"))
READY_TIMEOUT_S = int(os.environ.get("NEXUS_READY_TIMEOUT", "900"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_profile(name: str) -> dict:
    path = PROFILES_DIR / f"{name}.json"
    if not path.exists():
        raise SystemExit(f"unknown profile '{name}' (looked for {path})")
    profile = json.loads(path.read_text())
    profile["name"] = name
    return profile


def container_name(worker: str) -> str:
    return f"nexus-{worker}"


def state_path(worker: str) -> Path:
    return STATE_DIR / f"{worker}.json"


def read_state(worker: str) -> dict | None:
    path = state_path(worker)
    return json.loads(path.read_text()) if path.exists() else None


def write_state(worker: str, state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_path(worker).write_text(json.dumps(state, indent=2))


def vllm_args(profile: dict) -> list[str]:
    args = [
        "--model", profile["model"],
        "--served-model-name", profile.get("served_model_name", profile["model"]),
        "--gpu-memory-utilization", str(profile["gpu_memory_utilization"]),
        "--max-model-len", str(profile["max_model_len"]),
    ]
    if profile.get("enable_auto_tool_choice"):
        args.append("--enable-auto-tool-choice")
    if profile.get("tool_call_parser"):
        args += ["--tool-call-parser", profile["tool_call_parser"]]
    if profile.get("reasoning_parser"):
        args += ["--reasoning-parser", profile["reasoning_parser"]]
    if profile.get("chat_template"):
        args += ["--chat-template", f"/templates/{profile['chat_template']}"]
    args += profile.get("extra_args", [])
    return args


def docker_run_command(worker: str, port: int, profile: dict) -> list[str]:
    cmd = [
        "docker", "run", "-d",
        "--name", container_name(worker),
        "--gpus", "all",
        "--ipc=host",
        "--network", NETWORK,
        "-p", f"{port}:8000",
        "-v", f"{HF_HOME}:/root/.cache/huggingface",
        "-v", f"{TEMPLATES_DIR}:/templates:ro",
        "--label", f"nexus.worker={worker}",
        "--label", f"nexus.profile={profile['name']}",
    ]
    if os.environ.get("HF_TOKEN"):
        cmd += ["-e", "HF_TOKEN"]
    cmd.append(profile.get("image", DEFAULT_IMAGE))
    return cmd + vllm_args(profile)


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check)


def remove_container(worker: str) -> None:
    docker("rm", "-f", container_name(worker), check=False)


def wait_ready(port: int, served_name: str, timeout_s: int = READY_TIMEOUT_S) -> float:
    """Block until /health is 200 and the model is listed. Returns seconds waited."""
    start = time.monotonic()
    base = f"http://localhost:{port}"
    while time.monotonic() - start < timeout_s:
        try:
            if httpx.get(f"{base}/health", timeout=5).status_code == 200:
                models = httpx.get(f"{base}/v1/models", timeout=5).json()
                if any(m.get("id") == served_name for m in models.get("data", [])):
                    return time.monotonic() - start
        except httpx.HTTPError:
            pass
        time.sleep(3)
    raise TimeoutError(f"worker on :{port} not ready after {timeout_s}s")


def launch(worker: str, port: int, profile: dict) -> float:
    remove_container(worker)
    cmd = docker_run_command(worker, port, profile)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"docker run failed: {result.stderr.strip()}")
    return wait_ready(port, profile.get("served_model_name", profile["model"]))


def up(worker: str, profile_name: str, port: int) -> dict:
    profile = load_profile(profile_name)
    waited = launch(worker, port, profile)
    state = {
        "worker": worker,
        "port": port,
        "profile": profile_name,
        "launch_command": docker_run_command(worker, port, profile),
        "ready_seconds": round(waited, 1),
        "history": [],
    }
    write_state(worker, state)
    return state


def apply(worker: str, profile_name: str) -> dict:
    """Switch a running worker to another profile. Returns a rollback token."""
    state = read_state(worker)
    if state is None:
        raise SystemExit(f"worker '{worker}' has no state; run 'up' first")
    before = state["profile"]
    profile = load_profile(profile_name)
    waited = launch(worker, state["port"], profile)
    change = {
        "change_id": uuid.uuid4().hex[:12],
        "from_profile": before,
        "to_profile": profile_name,
        "applied_at": now(),
        "ready_seconds": round(waited, 1),
    }
    state["history"].append(change)
    state["profile"] = profile_name
    state["launch_command"] = docker_run_command(worker, state["port"], profile)
    write_state(worker, state)
    return change


def rollback(worker: str, change_id: str) -> dict:
    state = read_state(worker)
    if state is None:
        raise SystemExit(f"worker '{worker}' has no state")
    change = next((c for c in state["history"] if c["change_id"] == change_id), None)
    if change is None:
        raise SystemExit(f"unknown change_id '{change_id}' for worker '{worker}'")
    result = apply(worker, change["from_profile"])
    result["rolled_back"] = change_id
    return result


def down(worker: str) -> None:
    remove_container(worker)
    state_path(worker).unlink(missing_ok=True)


def status() -> list[dict]:
    rows = []
    for path in sorted(STATE_DIR.glob("*.json")):
        state = json.loads(path.read_text())
        inspect = docker("inspect", "-f", "{{.State.Status}}", container_name(state["worker"]), check=False)
        rows.append({
            "worker": state["worker"],
            "port": state["port"],
            "profile": state["profile"],
            "container": inspect.stdout.strip() or "missing",
            "changes": len(state["history"]),
        })
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.target.manager")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_up = sub.add_parser("up")
    p_up.add_argument("worker")
    p_up.add_argument("profile")
    p_up.add_argument("--port", type=int, required=True)
    p_apply = sub.add_parser("apply")
    p_apply.add_argument("worker")
    p_apply.add_argument("profile")
    p_rb = sub.add_parser("rollback")
    p_rb.add_argument("worker")
    p_rb.add_argument("change_id")
    p_down = sub.add_parser("down")
    p_down.add_argument("worker")
    sub.add_parser("status")
    p_cmd = sub.add_parser("command", help="print the docker run command without running it")
    p_cmd.add_argument("worker")
    p_cmd.add_argument("profile")
    p_cmd.add_argument("--port", type=int, default=8101)

    args = parser.parse_args(argv)
    if args.cmd == "up":
        out = up(args.worker, args.profile, args.port)
    elif args.cmd == "apply":
        out = apply(args.worker, args.profile)
    elif args.cmd == "rollback":
        out = rollback(args.worker, args.change_id)
    elif args.cmd == "down":
        down(args.worker)
        out = {"worker": args.worker, "removed": True}
    elif args.cmd == "status":
        out = status()
    else:
        out = " ".join(docker_run_command(args.worker, args.port, load_profile(args.profile)))
    print(out if isinstance(out, str) else json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
