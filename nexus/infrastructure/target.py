"""General target-environment interface and HTTP implementation."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol


class EnvironmentClientError(RuntimeError):
    """Raised when a target environment cannot provide a bounded observation."""


class EnvironmentProvider(Protocol):
    """Read-only capabilities required by the general diagnostic tool surface."""

    def describe_environment(self) -> dict[str, Any]: ...

    def list_resources(self) -> dict[str, Any]: ...

    def get_resource_state(
        self, resource_id: str, fields: list[str]
    ) -> dict[str, Any]: ...

    def get_configuration(
        self, resource_id: str, keys: list[str]
    ) -> dict[str, Any]: ...

    def query_logs(
        self,
        resource_id: str,
        since: str,
        query: str,
        limit: int,
    ) -> dict[str, Any]: ...

    def query_metrics(
        self,
        resource_id: str,
        metric: str,
        window: str,
    ) -> dict[str, Any]: ...

    def run_probe(self, probe_id: str, inputs: dict[str, Any]) -> dict[str, Any]: ...

    def read_artifact(self, artifact_id: str, section: str) -> dict[str, Any]: ...


@dataclass(frozen=True)
class HttpEnvironmentConfig:
    base_url: str
    api_key: str = ""
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls) -> "HttpEnvironmentConfig":
        base_url = os.environ.get("NEXUS_ENVIRONMENT_URL", "").strip()
        if not base_url:
            raise EnvironmentClientError("NEXUS_ENVIRONMENT_URL is required")
        return cls(
            base_url=base_url,
            api_key=os.environ.get("NEXUS_ENVIRONMENT_API_KEY", ""),
            timeout_seconds=float(
                os.environ.get("NEXUS_ENVIRONMENT_TIMEOUT_SECONDS", "30")
            ),
        )


class HttpEnvironmentProvider:
    """Client for the environment-neutral Nexus target-harness API."""

    def __init__(self, config: HttpEnvironmentConfig) -> None:
        self.config = config

    def describe_environment(self) -> dict[str, Any]:
        return self._request("GET", "/environment")

    def list_resources(self) -> dict[str, Any]:
        return self._request("GET", "/resources")

    def get_resource_state(
        self, resource_id: str, fields: list[str]
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/resources/{self._segment(resource_id)}/state",
            {"fields": fields},
        )

    def get_configuration(
        self, resource_id: str, keys: list[str]
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/resources/{self._segment(resource_id)}/configuration",
            {"keys": keys},
        )

    def query_logs(
        self,
        resource_id: str,
        since: str,
        query: str,
        limit: int,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/logs/query",
            {
                "resource_id": resource_id,
                "since": since,
                "query": query,
                "limit": limit,
            },
        )

    def query_metrics(
        self,
        resource_id: str,
        metric: str,
        window: str,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/metrics/query",
            {
                "resource_id": resource_id,
                "metric": metric,
                "window": window,
            },
        )

    def run_probe(self, probe_id: str, inputs: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/probes/{self._segment(probe_id)}/run",
            {"inputs": inputs},
        )

    def read_artifact(self, artifact_id: str, section: str) -> dict[str, Any]:
        return self._request(
            "POST",
            "/artifacts/read",
            {"artifact_id": artifact_id, "section": section},
        )

    @staticmethod
    def _segment(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        request = urllib.request.Request(
            f"{self.config.base_url.rstrip('/')}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.config.timeout_seconds
            ) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read(2_000).decode("utf-8", errors="replace")
            raise EnvironmentClientError(
                f"environment returned HTTP {exc.code}: {detail}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise EnvironmentClientError(f"environment request failed: {exc}") from exc
        if not isinstance(result, dict):
            raise EnvironmentClientError("environment response must be an object")
        return result
