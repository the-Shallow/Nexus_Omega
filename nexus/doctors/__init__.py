"""The two doctors: tool collections run by one controller loop."""

from .base import CLOCK_BASE_S, CONTROLLER, clock
from .infradoc import InfrastructureDoctor
from .manager import DoctorManager
from .tooldoc import ToolCallDoctor

__all__ = ["CLOCK_BASE_S", "CONTROLLER", "clock", "DoctorManager", "InfrastructureDoctor", "ToolCallDoctor"]
