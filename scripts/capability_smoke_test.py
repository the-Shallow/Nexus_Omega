"""Exercise one native model-selected capability call in scripted or live mode."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from nexus.agent.contracts import ModelTurn, ToolCall
from nexus.agent.tool_loop import ToolLoopController
from nexus.infrastructure.events import JsonlEventLog
from nexus.infrastructure.nemotron import (
    ScriptedNemotronClient,
    VLLMClientConfig,
    VLLMNemotronClient,
)
from nexus.tools.registry import ToolDefinition, ToolRegistry


def capability_registry() -> ToolRegistry:
    return ToolRegistry(
        [
            ToolDefinition(
                name="describe_environment",
                description="Return the capabilities declared for this smoke run.",
                parameters={
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
                handler=lambda args: {
                    "id": "capability-smoke",
                    "description": "Minimal controller capability test.",
                    "resources": [],
                    "probes": [],
                    "actions": [],
                },
            )
        ]
    )


def scripted_client() -> ScriptedNemotronClient:
    return ScriptedNemotronClient(
        [
            ModelTurn(
                tool_calls=(
                    ToolCall("call-capabilities", "describe_environment", {}),
                )
            ),
            ModelTurn(
                content=json.dumps(
                    {
                        "state": "DIAGNOSE",
                        "summary": "Declared capabilities were collected.",
                        "hypotheses": [],
                        "stop_reason": None,
                    }
                )
            ),
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("scripted", "live"), default="scripted")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument(
        "--event-dir", type=Path, default=Path("artifacts/capability-smoke-test")
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.runs < 1:
        raise SystemExit("--runs must be at least 1")
    summaries = []
    for index in range(1, args.runs + 1):
        run_id = f"capability-{args.mode}-{index:02d}"
        client = (
            scripted_client()
            if args.mode == "scripted"
            else VLLMNemotronClient(VLLMClientConfig.from_env())
        )
        result = ToolLoopController(
            run_id=run_id,
            client=client,
            tools=capability_registry(),
            event_log=JsonlEventLog(
                args.event_dir / run_id / "events.jsonl", run_id
            ),
        ).run("Inspect the declared environment before choosing a diagnostic step.")
        if result.tool_calls != 1 or result.decision.state != "DIAGNOSE":
            raise RuntimeError(f"capability contract failed for {run_id}")
        summaries.append(
            {
                "run_id": run_id,
                "state": result.decision.state,
                "steps": result.steps,
                "tool_calls": result.tool_calls,
            }
        )
    print(json.dumps({"mode": args.mode, "runs": summaries}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
