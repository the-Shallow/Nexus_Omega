"""Hard runtime limits enforced outside the language model."""

from __future__ import annotations

import time
from dataclasses import dataclass, field


class BudgetExceeded(RuntimeError):
    """Raised when a controller attempts to exceed a fixed run budget."""


@dataclass
class RunBudget:
    max_steps: int = 4
    max_tool_calls: int = 2
    max_total_operations: int | None = None
    timeout_seconds: float = 30.0
    _steps: int = field(default=0, init=False)
    _tool_calls: int = field(default=0, init=False)
    _started_at: float = field(default_factory=time.monotonic, init=False)

    @property
    def steps(self) -> int:
        return self._steps

    @property
    def tool_calls(self) -> int:
        return self._tool_calls

    def consume_step(self) -> None:
        self._check_timeout()
        self._check_total_operations()
        if self._steps >= self.max_steps:
            raise BudgetExceeded(f"step budget exceeded ({self.max_steps})")
        self._steps += 1

    def consume_tool_call(self) -> None:
        self._check_timeout()
        self._check_total_operations()
        if self._tool_calls >= self.max_tool_calls:
            raise BudgetExceeded(f"tool-call budget exceeded ({self.max_tool_calls})")
        self._tool_calls += 1

    def _check_timeout(self) -> None:
        if time.monotonic() - self._started_at > self.timeout_seconds:
            raise BudgetExceeded(f"run timeout exceeded ({self.timeout_seconds}s)")

    def _check_total_operations(self) -> None:
        if (
            self.max_total_operations is not None
            and self._steps + self._tool_calls >= self.max_total_operations
        ):
            raise BudgetExceeded(
                f"total operation budget exceeded ({self.max_total_operations})"
            )


@dataclass
class ContextBudget:
    """Limits model-directed context expansion independently of token limits."""

    max_rounds: int = 5
    max_requests_per_turn: int = 3
    max_repeated_requests: int = 2
    max_source_files: int = 8
    max_file_lines_per_request: int = 250
    max_source_lines: int = 1_500
    _rounds: int = field(default=0, init=False)
    _request_counts: dict[str, int] = field(default_factory=dict, init=False)
    _source_files: set[str] = field(default_factory=set, init=False)
    _source_lines: int = field(default=0, init=False)

    @property
    def rounds(self) -> int:
        return self._rounds

    def begin_round(self, request_count: int) -> None:
        if request_count < 1:
            raise ValueError("a context-expansion round must contain a request")
        if request_count > self.max_requests_per_turn:
            raise BudgetExceeded(
                "context requests per turn exceeded "
                f"({self.max_requests_per_turn})"
            )
        if self._rounds >= self.max_rounds:
            raise BudgetExceeded(f"context-expansion budget exceeded ({self.max_rounds})")
        self._rounds += 1

    def consume_request(self, request_key: str) -> None:
        count = self._request_counts.get(request_key, 0)
        if count >= self.max_repeated_requests:
            raise BudgetExceeded(
                "repeated context request exceeded "
                f"({self.max_repeated_requests}): {request_key}"
            )
        self._request_counts[request_key] = count + 1

    def consume_source(self, path: str, line_count: int) -> None:
        if line_count < 0:
            raise ValueError("source line count cannot be negative")
        if line_count > self.max_file_lines_per_request:
            raise BudgetExceeded(
                "source lines per request exceeded "
                f"({self.max_file_lines_per_request})"
            )
        if path not in self._source_files and len(self._source_files) >= self.max_source_files:
            raise BudgetExceeded(f"source file budget exceeded ({self.max_source_files})")
        if self._source_lines + line_count > self.max_source_lines:
            raise BudgetExceeded(f"source line budget exceeded ({self.max_source_lines})")
        self._source_files.add(path)
        self._source_lines += line_count
