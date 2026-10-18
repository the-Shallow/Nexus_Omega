"""Nemotron client interface and vLLM HTTP implementation."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from ..agent.contracts import ContractError, ModelTurn


class ModelClientError(RuntimeError):
    """Raised when the model endpoint cannot provide a usable response."""


class NemotronClient(Protocol):
    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> ModelTurn:
        """Return one validated assistant turn."""


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

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> ModelTurn:
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": 0,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        body = json.dumps(payload).encode("utf-8")
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
    ) -> ModelTurn:
        self.requests.append({"messages": list(messages), "tools": list(tools)})
        try:
            return next(self._turns)
        except StopIteration as exc:
            raise ModelClientError("scripted client has no response remaining") from exc
