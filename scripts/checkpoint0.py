"""Run the Checkpoint 0 contract in scripted or live Nemotron mode."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from nexus.agent.client import (
    ScriptedNemotronClient,
    VLLMClientConfig,
    VLLMNemotronClient,
)
from nexus.agent.contracts import ModelTurn, ToolCall
from nexus.agent.events import JsonlEventLog
from nexus.agent.runtime import CheckpointZeroController
from nexus.agent.tools import build_checkpoint_zero_registry


def scripted_client() -> ScriptedNemotronClient:
    decision = {
        "state": "DIAGNOSE",
        "summary": "The declared controller topology was collected successfully.",
        "hypotheses": [],
        "stop_reason": None,
    }
    return ScriptedNemotronClient(
        [
            ModelTurn(
                tool_calls=(
                    ToolCall(
                        call_id="call-topology",
                        name="get_topology",
                        arguments={},
                    ),
                )
            ),
            ModelTurn(content=json.dumps(decision)),
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("scripted", "live"), default="scripted")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument(
        "--event-dir", type=Path, default=Path("artifacts/checkpoint-0")
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.runs < 1:
        raise SystemExit("--runs must be at least 1")
    summaries = []
    for index in range(1, args.runs + 1):
        run_id = f"checkpoint-0-{args.mode}-{index:02d}"
        client = (
            scripted_client()
            if args.mode == "scripted"
            else VLLMNemotronClient(VLLMClientConfig.from_env())
        )
        controller = CheckpointZeroController(
            run_id=run_id,
            client=client,
            tools=build_checkpoint_zero_registry(),
            event_log=JsonlEventLog(args.event_dir / run_id / "events.jsonl", run_id),
        )
        result = controller.run(
            "Inspect the declared service topology before deciding the next diagnostic state."
        )
        if result.tool_calls != 1 or result.decision.state != "DIAGNOSE":
            raise RuntimeError(f"checkpoint contract failed for {run_id}")
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
