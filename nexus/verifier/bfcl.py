"""BFCL tool-call score for one worker: how much tool calling users get under a serving config.

Cases come from the Berkeley Function Calling Leaderboard (Apache-2.0) at a
pinned gorilla commit. `fetch` draws a fixed, seeded subset per category into
runtime/bfcl/subset.jsonl (committed, so every arm sees the same cases).
`run` sends each case to one worker's /v1/chat/completions with tools= and
scores the parsed tool_calls with a port of BFCL's AST rules:

  simple / multiple   exactly one call; right function; required params
                      present; no unknown params; each value among the
                      allowed answers ("" allowed = may be omitted)
  parallel            same number of calls, matched in any order
  irrelevance         no tool call at all

Strings are compared the way BFCL standardizes them (case, spaces and
,./-_*^ ignored); an int is accepted where a float is expected. Function
names with dots are sent with underscores, as BFCL's open-model handlers do.
Measured numbers are ours; the paper's 0.00 -> 0.96 is cited separately.

Usage:
    python -m nexus.verifier.bfcl fetch
    python -m nexus.verifier.bfcl run --port 8101 --label tools-template
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
SUBSET = ROOT / "runtime" / "bfcl" / "subset.jsonl"
OUT = ROOT / "artifacts" / "bfcl"
COMMIT = "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"
BASE = (f"https://raw.githubusercontent.com/ShishirPatil/gorilla/{COMMIT}"
        "/berkeley-function-call-leaderboard/bfcl_eval/data")
CATEGORIES = {"simple": "simple_python", "multiple": "multiple", "parallel": "parallel", "irrelevance": "irrelevance"}
PER_CATEGORY = 50
SEED = 548
MODEL = "qwen25-coder"
TYPES = {"dict": "object", "float": "number", "tuple": "array", "any": "string"}
PUNCT = re.compile(r"[ ,./\-_*^]")


def jsonl(url: str) -> list[dict]:
    resp = httpx.get(url, timeout=60)
    resp.raise_for_status()
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


def fetch() -> dict:
    rows = []
    rng = random.Random(SEED)
    for category, stem in CATEGORIES.items():
        cases = jsonl(f"{BASE}/BFCL_v4_{stem}.json")
        answers = {} if category == "irrelevance" else \
            {a["id"]: a["ground_truth"] for a in jsonl(f"{BASE}/possible_answer/BFCL_v4_{stem}.json")}
        for case in sorted(rng.sample(cases, PER_CATEGORY), key=lambda c: c["id"]):
            rows.append({"category": category, "id": case["id"], "messages": case["question"][0],
                         "functions": case["function"], "ground_truth": answers.get(case["id"])})
    SUBSET.parent.mkdir(parents=True, exist_ok=True)
    header = {"source": "BFCL v4 (gorilla-llm, Apache-2.0)", "commit": COMMIT, "seed": SEED,
              "per_category": PER_CATEGORY, "categories": CATEGORIES}
    SUBSET.write_text("\n".join(json.dumps(r) for r in [header, *rows]) + "\n")
    return {**header, "cases": len(rows), "path": str(SUBSET.relative_to(ROOT))}


def load_subset() -> tuple[dict, list[dict]]:
    lines = [json.loads(line) for line in SUBSET.read_text().splitlines() if line.strip()]
    return lines[0], lines[1:]


def to_schema(node):
    if isinstance(node, dict):
        out = {k: to_schema(v) for k, v in node.items()}
        if isinstance(out.get("type"), str):
            out["type"] = TYPES.get(out["type"], out["type"])
        return out
    if isinstance(node, list):
        return [to_schema(v) for v in node]
    return node


def tools_for(functions: list[dict]) -> list[dict]:
    return [{"type": "function", "function": {"name": f["name"].replace(".", "_"),
                                              "description": f.get("description", ""),
                                              "parameters": to_schema(f["parameters"])}}
            for f in functions]


def standard(value):
    if isinstance(value, str):
        return PUNCT.sub("", value).lower()
    if isinstance(value, list):
        return [standard(v) for v in value]
    if isinstance(value, dict):
        return {k: standard(v) for k, v in value.items()}
    return value


def value_ok(got, allowed: list, expected_type: str | None) -> bool:
    if expected_type == "float" and isinstance(got, int) and not isinstance(got, bool):
        got = float(got)
    if expected_type == "tuple" and isinstance(got, list):
        allowed = [list(a) if isinstance(a, (list, tuple)) else a for a in allowed]
    for option in allowed:
        if option == "":
            continue
        if isinstance(option, (int, float)) and not isinstance(option, bool) and isinstance(got, (int, float)):
            if float(got) == float(option):
                return True
        elif standard(got) == standard(option):
            return True
    return False


def call_ok(call: dict, expected: dict, functions: dict[str, dict]) -> bool:
    (name, params), = expected.items()
    if call["name"] != name.replace(".", "_"):
        return False
    spec = functions[name]["parameters"]
    props, required = spec.get("properties", {}), spec.get("required", [])
    args = call["arguments"]
    if any(r not in args for r in required) or any(k not in params for k in args):
        return False
    for key, allowed in params.items():
        if key not in args:
            if "" not in allowed:
                return False
        elif not value_ok(args[key], allowed, props.get(key, {}).get("type")):
            return False
    return True


def score_case(case: dict, calls: list[dict] | None) -> bool:
    if case["category"] == "irrelevance":
        return not calls
    if not calls or len(calls) != len(case["ground_truth"]):
        return False
    functions = {f["name"]: f for f in case["functions"]}
    remaining = list(case["ground_truth"])
    for call in calls:
        match = next((e for e in remaining if call_ok(call, e, functions)), None)
        if match is None:
            return False
        remaining.remove(match)
    return True


def ask(client: httpx.Client, base: str, case: dict) -> dict:
    body = {"model": MODEL, "messages": case["messages"], "tools": tools_for(case["functions"]),
            "tool_choice": "auto", "temperature": 0, "max_tokens": 512}
    try:
        resp = client.post(f"{base}/v1/chat/completions", json=body)
    except httpx.HTTPError as exc:
        return {"http_status": 0, "error": type(exc).__name__, "calls": None}
    if resp.status_code != 200:
        return {"http_status": resp.status_code, "calls": None}
    message = resp.json()["choices"][0]["message"]
    calls = []
    for tc in message.get("tool_calls") or []:
        try:
            args = json.loads(tc["function"]["arguments"] or "{}")
        except json.JSONDecodeError:
            args = {"__unparsed__": tc["function"]["arguments"]}
        calls.append({"name": tc["function"]["name"], "arguments": args})
    return {"http_status": 200, "calls": calls, "content": (message.get("content") or "")[:300]}


def run(port: int, label: str, workers: int = 8) -> dict:
    header, cases = load_subset()
    base = f"http://localhost:{port}"
    with httpx.Client(timeout=120) as client, ThreadPoolExecutor(workers) as pool:
        replies = list(pool.map(lambda c: ask(client, base, c), cases))
    results = [{"id": c["id"], "category": c["category"], "ok": score_case(c, r["calls"]), **r}
               for c, r in zip(cases, replies)]
    by_category = {}
    for category in CATEGORIES:
        rows = [r for r in results if r["category"] == category]
        by_category[category] = {"passed": sum(r["ok"] for r in rows), "total": len(rows),
                                 "score": round(sum(r["ok"] for r in rows) / len(rows), 3)}
    calling = [r for r in results if r["category"] != "irrelevance"]
    out = {"label": label, "port": port, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "bfcl": header, "by_category": by_category,
           "tool_calling_score": round(sum(r["ok"] for r in calling) / len(calling), 3),
           "overall": round(sum(r["ok"] for r in results) / len(results), 3),
           "http_errors": sum(r["http_status"] != 200 for r in results), "results": results}
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{label}-{out['at'].replace(':', '')}.json"
    path.write_text(json.dumps(out, indent=2) + "\n")
    out["path"] = str(path.relative_to(ROOT))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.verifier.bfcl")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    p_run = sub.add_parser("run")
    p_run.add_argument("--port", type=int, required=True)
    p_run.add_argument("--label", required=True, help="serving arm, e.g. the profile name")
    args = parser.parse_args(argv)
    if args.cmd == "fetch":
        print(json.dumps(fetch(), indent=2))
        return 0
    out = run(args.port, args.label)
    print(json.dumps({k: out[k] for k in ("label", "by_category", "tool_calling_score", "overall",
                                          "http_errors", "path")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
