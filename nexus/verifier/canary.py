"""Functional tool-call canary for a vLLM endpoint.

Checks that the server returns *structured* tool calls, which is stricter than
checking that it answers. Each case records the HTTP status, the structured
response, and (optionally) the model's raw generation captured separately, so a
silent parser/template failure is visible as "raw text contains a call, but
tool_calls is empty".

Usage:
    python -m nexus.verifier.canary --url http://localhost:8101 --model qwen3-4b --repeat 3 --raw
Exit code is 0 only when every case passes on every repeat.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
            },
            "required": ["city"],
        },
    },
}

TIME_TOOL = {
    "type": "function",
    "function": {
        "name": "get_local_time",
        "description": "Get the current local time in a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name"}},
            "required": ["city"],
        },
    },
}

# expect_tool=None means the model must answer without calling a tool.
BUILTIN_CASES = [
    {
        "name": "single_call",
        "messages": [{"role": "user", "content": "What is the weather in Raleigh right now, in celsius?"}],
        "tools": [WEATHER_TOOL],
        "expect_tool": "get_weather",
        "expect_args": {"city": "raleigh"},
    },
    {
        "name": "select_tool",
        "messages": [{"role": "user", "content": "What time is it in Tokyo?"}],
        "tools": [WEATHER_TOOL, TIME_TOOL],
        "expect_tool": "get_local_time",
        "expect_args": {"city": "tokyo"},
    },
    {
        "name": "no_tool_needed",
        "messages": [{"role": "user", "content": "Reply with the single word: hello"}],
        "tools": [WEATHER_TOOL],
        "expect_tool": None,
    },
    {
        "name": "streaming_call",
        "messages": [{"role": "user", "content": "Check the weather in Montreal."}],
        "tools": [WEATHER_TOOL],
        "expect_tool": "get_weather",
        "expect_args": {"city": "montreal"},
        "stream": True,
    },
]


def load_cases(path: str | None) -> list[dict]:
    if not path:
        return BUILTIN_CASES
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def request_body(model: str, case: dict, no_think: bool) -> dict:
    body = {
        "model": model,
        "messages": case["messages"],
        "tools": case["tools"],
        "tool_choice": "auto",
        "temperature": 0,
        "seed": 0,
        "max_tokens": 512,
    }
    if no_think:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    return body


def collect_stream(client: httpx.Client, url: str, body: dict) -> tuple[int, dict]:
    """Reassemble a streamed chat completion into one message dict."""
    content, calls = [], {}
    with client.stream("POST", url, json={**body, "stream": True}) as resp:
        if resp.status_code != 200:
            return resp.status_code, {"error": resp.read().decode(errors="replace")[:500]}
        for line in resp.iter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            delta = json.loads(line[6:])["choices"][0].get("delta", {})
            if delta.get("content"):
                content.append(delta["content"])
            for tc in delta.get("tool_calls") or []:
                slot = calls.setdefault(tc.get("index", 0), {"function": {"name": "", "arguments": ""}})
                fn = tc.get("function") or {}
                slot["function"]["name"] += fn.get("name") or ""
                slot["function"]["arguments"] += fn.get("arguments") or ""
    message = {"content": "".join(content) or None, "tool_calls": [calls[i] for i in sorted(calls)]}
    return 200, message


def raw_generation(client: httpx.Client, base: str, model: str, case: dict, no_think: bool) -> dict:
    """Render the prompt with the server's chat template, then generate without any parser.

    Uses /tokenize (chat form) followed by /v1/completions on the token IDs, so the
    returned text is exactly what the model produced before tool/reasoning parsing.
    """
    tok_body = {"model": model, "messages": case["messages"], "tools": case["tools"], "add_generation_prompt": True}
    if no_think:
        tok_body["chat_template_kwargs"] = {"enable_thinking": False}
    try:
        tok = client.post(f"{base}/tokenize", json=tok_body)
        if tok.status_code != 200:
            return {"available": False, "reason": f"/tokenize returned {tok.status_code}"}
        comp = client.post(f"{base}/v1/completions", json={
            "model": model, "prompt": tok.json()["tokens"], "temperature": 0, "seed": 0, "max_tokens": 512,
        })
        if comp.status_code != 200:
            return {"available": False, "reason": f"/v1/completions returned {comp.status_code}"}
        return {"available": True, "text": comp.json()["choices"][0]["text"]}
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        return {"available": False, "reason": repr(exc)}


def judge(case: dict, message: dict) -> tuple[bool, str]:
    calls = message.get("tool_calls") or []
    if case["expect_tool"] is None:
        return (not calls, "no tool call, as expected" if not calls else f"unexpected tool call: {calls[0]['function']['name']}")
    if not calls:
        return False, "no structured tool_calls in response"
    fn = calls[0]["function"]
    if fn["name"] != case["expect_tool"]:
        return False, f"called {fn['name']}, expected {case['expect_tool']}"
    try:
        args = json.loads(fn["arguments"] or "{}")
    except json.JSONDecodeError:
        return False, f"arguments are not valid JSON: {fn['arguments'][:120]}"
    for key, want in (case.get("expect_args") or {}).items():
        if want not in str(args.get(key, "")).lower():
            return False, f"argument {key}={args.get(key)!r} does not contain {want!r}"
    return True, "valid structured tool call"


def run_case(client: httpx.Client, base: str, model: str, case: dict, raw: bool, no_think: bool) -> dict:
    body = request_body(model, case, no_think)
    url = f"{base}/v1/chat/completions"
    start = time.monotonic()
    try:
        if case.get("stream"):
            status, message = collect_stream(client, url, body)
        else:
            resp = client.post(url, json=body)
            status = resp.status_code
            message = resp.json()["choices"][0]["message"] if status == 200 else {"error": resp.text[:500]}
    except httpx.HTTPError as exc:
        status, message = 0, {"error": repr(exc)}
    latency = round(time.monotonic() - start, 3)
    ok, reason = judge(case, message) if status == 200 else (False, f"HTTP {status}")
    result = {
        "case": case["name"],
        "ok": ok,
        "reason": reason,
        "http_status": status,
        "latency_s": latency,
        "content": (message.get("content") or "")[:500] if isinstance(message.get("content"), str) else None,
        "tool_calls": message.get("tool_calls") or [],
    }
    if raw and not case.get("stream"):
        result["raw_generation"] = raw_generation(client, base, model, case, no_think)
    return result


def health(client: httpx.Client, base: str) -> int:
    try:
        return client.get(f"{base}/health").status_code
    except httpx.HTTPError:
        return 0


def run(base: str, model: str, cases: list[dict], repeat: int, raw: bool, no_think: bool) -> dict:
    with httpx.Client(timeout=120) as client:
        runs = [[run_case(client, base, model, c, raw, no_think) for c in cases] for _ in range(repeat)]
        health_status = health(client, base)
    passed = all(r["ok"] for rep in runs for r in rep)
    return {"endpoint": base, "model": model, "health_status": health_status, "passed": passed, "repeats": runs}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.verifier.canary")
    parser.add_argument("--url", required=True, help="base URL, e.g. http://localhost:8101")
    parser.add_argument("--model", required=True, help="served model name")
    parser.add_argument("--cases", help="JSONL file of cases (defaults to built-in cases)")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--raw", action="store_true", help="also capture raw generation before parsing")
    parser.add_argument("--think", action="store_true", help="leave model thinking enabled")
    parser.add_argument("--out", help="write the full JSON result here")
    args = parser.parse_args(argv)

    result = run(args.url.rstrip("/"), args.model, load_cases(args.cases), args.repeat, args.raw, not args.think)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(result, indent=2))
    for i, rep in enumerate(result["repeats"], 1):
        for r in rep:
            print(f"[{i}] {'PASS' if r['ok'] else 'FAIL'}  {r['case']:<16} {r['reason']}")
    print(f"health={result['health_status']}  canary={'PASS' if result['passed'] else 'FAIL'}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
