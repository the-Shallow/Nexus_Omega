"""CPU regression observation for malformed Responses tool arguments."""

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from openai.types.responses import ResponseFunctionToolCall
from vllm.entrypoints.openai.responses import context as responses_context


async def observe():
    responses_context.envs.VLLM_TOOL_JSON_ERROR_AUTOMATIC_RETRY = True
    context = object.__new__(responses_context.ParsableContext)
    context.called_tools = set()
    session = SimpleNamespace(call_tool=AsyncMock())
    call = ResponseFunctionToolCall(
        id="fc_probe",
        call_id="call_probe",
        type="function_call",
        name="web_search_preview",
        arguments='{"unterminated":',
    )
    try:
        output = await context.call_search_tool(session, call)
    except Exception as exc:
        return {
            "reproduced": isinstance(exc, AttributeError),
            "summary": "Malformed tool arguments raised during retry handling.",
            "exception_type": type(exc).__name__,
            "exception_message": str(exc),
            "dispatch_count": session.call_tool.await_count,
        }
    retry = output[0] if output else None
    return {
        "reproduced": False,
        "summary": "Retry handling returned an output item.",
        "retry_call_id": getattr(retry, "call_id", None),
        "retry_output": getattr(retry, "output", None),
        "dispatch_count": session.call_tool.await_count,
    }


if __name__ == "__main__":
    result = asyncio.run(observe())
    Path(os.environ["NEXUS_PROBE_RESULT_PATH"]).write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )
