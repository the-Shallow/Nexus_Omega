"""Per-route SLO probe through the gateway.

Sends small chat requests through the gateway and groups latency and errors by
the worker that served each one (the x-nexus-worker header). This catches
faults on the path between the gateway and a worker, which the worker's own
vLLM metrics cannot see.

Usage:
    python -m nexus.verifier.route --url http://localhost:8100 --model qwen25-coder --requests 30
Exit code is 0 only when every worker meets the p95 latency and error-rate limits.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

import httpx


def p95(values: list[float]) -> float:
    if len(values) < 2:
        return values[0] if values else 0.0
    return statistics.quantiles(values, n=20, method="inclusive")[18]


def run(base: str, model: str, requests: int, max_p95_s: float, max_error_rate: float) -> dict:
    body = {"model": model, "messages": [{"role": "user", "content": "Reply with the word ok."}],
            "max_tokens": 8, "temperature": 0}
    latency: dict[str, list[float]] = defaultdict(list)
    errors: dict[str, int] = defaultdict(int)
    with httpx.Client(timeout=30) as client:
        for _ in range(requests):
            started = time.monotonic()
            try:
                resp = client.post(f"{base}/v1/chat/completions", json=body)
                worker, ok = resp.headers.get("x-nexus-worker", "unknown"), resp.status_code == 200
            except httpx.HTTPError:
                worker, ok = "unknown", False
            latency[worker].append(time.monotonic() - started)
            if not ok:
                errors[worker] += 1
        health = client.get(f"{base}/health").status_code

    workers = {}
    for worker, values in sorted(latency.items()):
        error_rate = errors[worker] / len(values)
        worst = p95(values)
        workers[worker] = {
            "requests": len(values),
            "p95_s": round(worst, 3),
            "median_s": round(statistics.median(values), 3),
            "error_rate": round(error_rate, 3),
            "ok": worst <= max_p95_s and error_rate <= max_error_rate,
        }
    return {"endpoint": base, "health_status": health, "limits": {"max_p95_s": max_p95_s,
            "max_error_rate": max_error_rate}, "passed": all(w["ok"] for w in workers.values()),
            "workers": workers}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.verifier.route")
    parser.add_argument("--url", required=True, help="gateway base URL, e.g. http://localhost:8100")
    parser.add_argument("--model", required=True, help="served model name")
    parser.add_argument("--requests", type=int, default=30)
    parser.add_argument("--max-p95", type=float, default=0.5, help="p95 latency limit in seconds")
    parser.add_argument("--max-error-rate", type=float, default=0.0)
    parser.add_argument("--out", help="write the full JSON result here")
    args = parser.parse_args(argv)

    result = run(args.url.rstrip("/"), args.model, args.requests, args.max_p95, args.max_error_rate)
    for worker, w in result["workers"].items():
        print(f"{'PASS' if w['ok'] else 'FAIL'}  {worker:8} n={w['requests']:3} "
              f"p95={w['p95_s']:.2f}s errors={w['error_rate']:.0%}")
    print(f"health={result['health_status']}  route={'PASS' if result['passed'] else 'FAIL'}")
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
