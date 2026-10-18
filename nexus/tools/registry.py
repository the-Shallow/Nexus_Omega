"""Generic definitions and validation for typed, allow-listed tools."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ..agent.contracts import ContractError


ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    return True


def validate_schema(value: Any, schema: dict[str, Any], label: str) -> None:
    expected = schema.get("type")
    if isinstance(expected, str) and not _matches_type(value, expected):
        raise ContractError(f"{label} must be of type {expected}")
    if "enum" in schema and value not in schema["enum"]:
        raise ContractError(f"{label} must be one of {schema['enum']}")
    if isinstance(value, str):
        minimum = schema.get("minLength")
        if isinstance(minimum, int) and len(value) < minimum:
            raise ContractError(f"{label} must contain at least {minimum} characters")
        maximum = schema.get("maxLength")
        if isinstance(maximum, int) and len(value) > maximum:
            raise ContractError(f"{label} must contain at most {maximum} characters")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise ContractError(f"{label} must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise ContractError(f"{label} must be at most {schema['maximum']}")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        missing = required - set(value)
        if missing:
            raise ContractError(f"missing arguments for {label}: {sorted(missing)}")
        if schema.get("additionalProperties") is False:
            unexpected = set(value) - set(properties)
            if unexpected:
                raise ContractError(
                    f"unexpected arguments for {label}: {sorted(unexpected)}"
                )
        for key, item in value.items():
            child_schema = properties.get(key)
            if isinstance(child_schema, dict):
                validate_schema(item, child_schema, f"{label}.{key}")
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        minimum = schema.get("minItems")
        if isinstance(minimum, int) and len(value) < minimum:
            raise ContractError(f"{label} must contain at least {minimum} items")
        maximum = schema.get("maxItems")
        if isinstance(maximum, int) and len(value) > maximum:
            raise ContractError(f"{label} must contain at most {maximum} items")
        for index, item in enumerate(value):
            validate_schema(item, schema["items"], f"{label}[{index}]")


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

    def validate(self, name: str, arguments: dict[str, Any]) -> ToolDefinition:
        definition = self._definitions.get(name)
        if definition is None:
            raise ContractError(f"unknown tool: {name}")
        if not isinstance(arguments, dict):
            raise ContractError("tool arguments must be an object")
        validate_schema(arguments, definition.parameters, name)
        return definition

    def invoke(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        definition = self.validate(name, arguments)
        return definition.handler(arguments)
