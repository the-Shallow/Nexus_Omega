"""Typed, allow-listed tools available at Checkpoint 0."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .contracts import ContractError


ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler

    def to_vllm(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    def __init__(self, definitions: list[ToolDefinition]) -> None:
        self._definitions = {item.name: item for item in definitions}
        if len(self._definitions) != len(definitions):
            raise ValueError("tool names must be unique")

    def schemas(self) -> list[dict[str, Any]]:
        return [self._definitions[name].to_vllm() for name in sorted(self._definitions)]

    def invoke(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        definition = self._definitions.get(name)
        if definition is None:
            raise ContractError(f"unknown tool: {name}")
        if not isinstance(arguments, dict):
            raise ContractError("tool arguments must be an object")
        allowed = set(definition.parameters.get("properties", {}))
        unexpected = set(arguments) - allowed
        if unexpected:
            raise ContractError(f"unexpected arguments for {name}: {sorted(unexpected)}")
        required = set(definition.parameters.get("required", []))
        missing = required - set(arguments)
        if missing:
            raise ContractError(f"missing arguments for {name}: {sorted(missing)}")
        return definition.handler(arguments)


def build_checkpoint_zero_registry() -> ToolRegistry:
    def get_topology(arguments: dict[str, Any]) -> dict[str, Any]:
        del arguments
        return {
            "topology_version": "checkpoint-0",
            "controller": {"id": "nexus-controller", "status": "ready"},
            "services": [],
            "source": "declared_runtime_state",
        }

    return ToolRegistry(
        [
            ToolDefinition(
                name="get_topology",
                description=(
                    "Return the controller's declared service topology. This is a "
                    "read-only operation and accepts no arguments."
                ),
                parameters={
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
                handler=get_topology,
            )
        ]
    )
