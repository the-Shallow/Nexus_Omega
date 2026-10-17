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
        if self._steps >= self.max_steps:
            raise BudgetExceeded(f"step budget exceeded ({self.max_steps})")
        self._steps += 1

    def consume_tool_call(self) -> None:
        self._check_timeout()
        if self._tool_calls >= self.max_tool_calls:
            raise BudgetExceeded(f"tool-call budget exceeded ({self.max_tool_calls})")
        self._tool_calls += 1

    def _check_timeout(self) -> None:
        if time.monotonic() - self._started_at > self.timeout_seconds:
            raise BudgetExceeded(f"run timeout exceeded ({self.timeout_seconds}s)")
