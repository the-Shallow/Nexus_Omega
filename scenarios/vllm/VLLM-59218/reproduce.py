"""CPU regression observation for content around Qwen3 tool calls."""

import json
import os
from pathlib import Path
from unittest.mock import MagicMock

from vllm.entrypoints.openai.chat_completion.protocol import ChatCompletionRequest
from vllm.parser.engine.parser_engine import ParserEngine
from vllm.parser.qwen3 import TOOL_CALL_END, TOOL_CALL_START, qwen3_config


def observe():
    vocab = {TOOL_CALL_START: 100, TOOL_CALL_END: 101}
    tokenizer = MagicMock()
    tokenizer.encode.return_value = [1, 2, 3]
    tokenizer.get_vocab.return_value = dict(vocab)
    tokenizer.decode.side_effect = lambda ids: "".join(
        {value: key for key, value in vocab.items()}.get(
            item, chr(item) if item < 128 else f"<{item}>"
        )
        for item in ids
    )
    tokenizer.all_special_tokens = list(vocab)
    tokenizer.all_special_ids = list(vocab.values())
    request = MagicMock(spec=ChatCompletionRequest)
    request.tools = []
    request.tool_choice = "auto"
    request.include_reasoning = True
    parser = ParserEngine(tokenizer, parser_engine_config=qwen3_config(thinking=False))
    call = (
        "<tool_call>\n<function=get_weather>\n"
        "<parameter=city>Tokyo</parameter>\n</function>\n</tool_call>"
    )
    cases = [
        (call + "\nDone.", "Done."),
        ("First Tokyo." + call + "\nNow again." + call, "First Tokyo.\nNow again."),
    ]
    observations = []
    for text, expected in cases:
        _, content, tool_calls = parser.parse(text, request)
        observations.append(
            {
                "expected_content": expected,
                "observed_content": content,
                "tool_call_count": len(tool_calls),
            }
        )
    passed = all(
        item["observed_content"] == item["expected_content"]
        and item["tool_call_count"] >= 1
        for item in observations
    )
    return {
        "reproduced": any(
            item["observed_content"] != item["expected_content"]
            for item in observations
        ),
        "passed": passed,
        "summary": "Nonstreaming parsing loses content adjacent to tool calls.",
        "cases": observations,
    }


if __name__ == "__main__":
    Path(os.environ["NEXUS_PROBE_RESULT_PATH"]).write_text(
        json.dumps(observe(), indent=2), encoding="utf-8"
    )
