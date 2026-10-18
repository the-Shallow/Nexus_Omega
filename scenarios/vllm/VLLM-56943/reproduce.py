"""CPU regression observation for shared engine error propagation."""

import json
import os
import traceback
from pathlib import Path

from vllm.sampling_params import RequestOutputKind
from vllm.v1.engine.exceptions import EngineDeadError
from vllm.v1.engine.output_processor import RequestOutputCollector


def observe():
    shared = EngineDeadError()
    depths = []
    same_instance = []
    for index in range(4):
        collector = RequestOutputCollector(
            RequestOutputKind.CUMULATIVE, request_id=f"probe-{index}"
        )
        collector.put(shared)
        try:
            collector.get_nowait()
        except EngineDeadError as exc:
            same_instance.append(exc is shared)
            depths.append(len(traceback.extract_tb(exc.__traceback__)))
    return {
        "reproduced": len(depths) == 4
        and all(same_instance)
        and all(later > earlier for earlier, later in zip(depths, depths[1:])),
        "summary": "Repeated request errors grow a shared traceback.",
        "traceback_depths": depths,
        "same_exception_instance": same_instance,
    }


if __name__ == "__main__":
    Path(os.environ["NEXUS_PROBE_RESULT_PATH"]).write_text(
        json.dumps(observe(), indent=2), encoding="utf-8"
    )
