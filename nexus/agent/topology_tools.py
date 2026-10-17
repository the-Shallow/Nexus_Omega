"""Read-only tools for inspecting declared service topology."""

from __future__ import annotations

from typing import Any

from .tooling import ToolDefinition, ToolRegistry


def build_topology_registry() -> ToolRegistry:
    """Build the minimal registry used to inspect controller topology."""

    def get_topology(arguments: dict[str, Any]) -> dict[str, Any]:
        del arguments
        return {
            "topology_version": "v1",
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
