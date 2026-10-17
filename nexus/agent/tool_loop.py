"""Generic bounded controller for model-directed tool round trips."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .budgets import RunBudget
from .client import NemotronClient
from .contracts import AgentDecision, ModelTurn
from .events import JsonlEventLog
from .tooling import ToolRegistry


SYSTEM_PROMPT = """You are the Nexus Omega diagnostic agent.
Use only the tools provided by the controller. Call get_topology before
returning a decision. After receiving its result, respond
with only a JSON object containing exactly: state, summary, hypotheses, and
stop_reason. Use state DIAGNOSE, hypotheses as an array, and null stop_reason.
Do not claim that an incident has been diagnosed or repaired.
"""


@dataclass(frozen=True)
class ToolLoopResult:
    run_id: str
    decision: AgentDecision
    steps: int
    tool_calls: int


class ToolLoopController:
    def __init__(
        self,
        *,
        run_id: str,
        client: NemotronClient,
        tools: ToolRegistry,
        event_log: JsonlEventLog,
        budget: RunBudget | None = None,
    ) -> None:
        self.run_id = run_id
        self.client = client
        self.tools = tools
        self.event_log = event_log
        self.budget = budget or RunBudget()

    def run(self, prompt: str) -> ToolLoopResult:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        self.event_log.append(
            "run_started",
            {
                "state": "INGEST",
                "limits": {
                    "max_steps": self.budget.max_steps,
                    "max_tool_calls": self.budget.max_tool_calls,
                    "timeout_seconds": self.budget.timeout_seconds,
                },
            },
        )
        try:
            while True:
                self.budget.consume_step()
                turn = self.client.complete(messages, self.tools.schemas())
                self._record_model_turn(turn)
                if turn.tool_calls:
                    messages.append(
                        {
                            "role": "assistant",
                            "content": turn.content,
                            "tool_calls": [item.to_vllm() for item in turn.tool_calls],
                        }
                    )
                    for call in turn.tool_calls:
                        self.budget.consume_tool_call()
                        result = self.tools.invoke(call.name, call.arguments)
                        self.event_log.append(
                            "tool_completed",
                            {
                                "call_id": call.call_id,
                                "name": call.name,
                                "arguments": call.arguments,
                                "result": result,
                            },
                        )
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.call_id,
                                "name": call.name,
                                "content": json.dumps(result, sort_keys=True),
                            }
                        )
                    continue

                decision = AgentDecision.from_json(turn.content or "")
                self.event_log.append("decision_validated", decision.to_dict())
                self.event_log.append(
                    "run_completed",
                    {
                        "state": decision.state,
                        "steps": self.budget.steps,
                        "tool_calls": self.budget.tool_calls,
                    },
                )
                return ToolLoopResult(
                    run_id=self.run_id,
                    decision=decision,
                    steps=self.budget.steps,
                    tool_calls=self.budget.tool_calls,
                )
        except Exception as exc:
            self.event_log.append(
                "run_failed",
                {"error_type": type(exc).__name__, "message": str(exc)},
            )
            raise

    def _record_model_turn(self, turn: ModelTurn) -> None:
        self.event_log.append(
            "model_turn_validated",
            {
                "has_content": bool(turn.content),
                "tool_calls": [
                    {
                        "call_id": call.call_id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                    for call in turn.tool_calls
                ],
            },
        )
