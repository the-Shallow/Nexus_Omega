"""Nemotron client interface and vLLM HTTP implementation."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from ..agent.contracts import ContractError, ModelTurn


FORMATTED_MAX_TOKENS = 1024


class ModelClientError(RuntimeError):
    """Raised when the model endpoint cannot provide a usable response."""


class NemotronClient(Protocol):
    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None = None,
    ) -> ModelTurn:
        """Return one validated assistant turn.

        response_format, when given, is passed to the server so constrained
        decoding enforces the shape of the reply (used for the final decision).
        """


@dataclass(frozen=True)
class VLLMClientConfig:
    base_url: str
    model: str
    api_key: str = ""
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls) -> "VLLMClientConfig":
        model = os.environ.get("NEMOTRON_MODEL", "").strip()
        if not model:
            raise ModelClientError("NEMOTRON_MODEL is required for live mode")
        return cls(
            base_url=os.environ.get("NEMOTRON_BASE_URL", "http://localhost:8000/v1"),
            model=model,
            api_key=os.environ.get("NEMOTRON_API_KEY", ""),
            timeout_seconds=float(os.environ.get("NEMOTRON_TIMEOUT_SECONDS", "30")),
        )


class VLLMNemotronClient:
    """Dependency-free client for a Nemotron model served by vLLM."""

    def __init__(self, config: VLLMClientConfig) -> None:
        self.config = config

    def build_payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": 0,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if response_format is not None:
            payload["response_format"] = response_format
            # A schema permits arbitrarily long arrays and strings; without a cap,
            # constrained decoding was seen running to the timeout. A decision
            # is a few hundred tokens.
            payload["max_tokens"] = FORMATTED_MAX_TOKENS
            # The formatted turn restates a decision already made; reasoning
            # tokens there only consume the cap.
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        return payload

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None = None,
    ) -> ModelTurn:
        body = json.dumps(self.build_payload(messages, tools, response_format)).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        request = urllib.request.Request(
            f"{self.config.base_url.rstrip('/')}/chat/completions",
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.config.timeout_seconds
            ) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read(2_000).decode("utf-8", errors="replace")
            raise ModelClientError(f"model endpoint returned HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ModelClientError(f"model endpoint request failed: {exc}") from exc

        try:
            message = response_payload["choices"][0]["message"]
            return ModelTurn.from_vllm_message(message)
        except (KeyError, IndexError, TypeError, ContractError) as exc:
            raise ModelClientError("model endpoint returned an invalid assistant message") from exc


class ScriptedNemotronClient:
    """Deterministic client used only for controller tests and local smoke runs."""

    def __init__(self, turns: list[ModelTurn]) -> None:
        self._turns = iter(turns)
        self.requests: list[dict[str, Any]] = []

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None = None,
    ) -> ModelTurn:
        self.requests.append({"messages": list(messages), "tools": list(tools),
                              "response_format": response_format})
        try:
            return next(self._turns)
        except StopIteration as exc:
            raise ModelClientError("scripted client has no response remaining") from exc
