"""Fleet SLO check against Prometheus.

Reads worker-side vLLM metrics (TTFT, queue depth, KV-cache use, scrape
health) and gateway-side route metrics (p95 latency, error rate) over a
recent window and compares them with limits. A series with no traffic in the
window reports null and is not counted as a breach; a worker that is not
scraping ("up" = 0) always is.

Usage:
    python -m nexus.verifier.slo --prometheus http://localhost:9090 --window 1m
Exit code is 0 only when no limit is breached.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import httpx

# name -> (PromQL with {w} for the window, label that identifies the series, limit flag)
CHECKS = {
    "worker_up": ('up{{job="vllm"}}', "instance", None),
    "ttft_p95_s": ('histogram_quantile(0.95, sum by (instance, le) '
                   '(rate(vllm:time_to_first_token_seconds_bucket[{w}])))', "instance", "max_ttft_p95"),
    "queue_waiting": ('max_over_time(vllm:num_requests_waiting[{w}])', "instance", "max_waiting"),
    "kv_cache_usage": ('max_over_time(vllm:kv_cache_usage_perc[{w}])', "instance", "max_kv_usage"),
    "route_p95_s": ('histogram_quantile(0.95, sum by (worker, le) '
                    '(rate(nexus_gateway_request_seconds_bucket[{w}])))', "worker", "max_route_p95"),
    "route_error_rate": ('sum by (worker) (rate(nexus_gateway_errors_total[{w}])) / '
                         'sum by (worker) (rate(nexus_gateway_requests_total[{w}]))', "worker", "max_error_rate"),
}


def query(client: httpx.Client, base: str, promql: str) -> list[dict]:
    resp = client.get(f"{base}/api/v1/query", params={"query": promql})
    resp.raise_for_status()
    return resp.json()["data"]["result"]


def run(base: str, window: str, limits: dict) -> dict:
    checks, breaches = {}, []
    with httpx.Client(timeout=10) as client:
        for name, (promql, label, limit_key) in CHECKS.items():
            series = {}
            for row in query(client, base, promql.format(w=window)):
                value = float(row["value"][1])
                key = row["metric"].get(label, "unknown")
                series[key] = None if math.isnan(value) else round(value, 4)
                if name == "worker_up" and value < 1:
                    breaches.append(f"{key} is down (not scraping)")
                elif limit_key and series[key] is not None and series[key] > limits[limit_key]:
                    breaches.append(f"{name} {key}={series[key]} > {limits[limit_key]}")
            checks[name] = series
    return {"prometheus": base, "window": window, "limits": limits, "passed": not breaches,
            "breaches": breaches, "checks": checks}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nexus.verifier.slo")
    parser.add_argument("--prometheus", default="http://localhost:9090")
    parser.add_argument("--window", default="1m", help="PromQL range, e.g. 1m or 5m")
    parser.add_argument("--max-ttft-p95", type=float, default=1.0, help="seconds")
    parser.add_argument("--max-waiting", type=float, default=10)
    parser.add_argument("--max-kv-usage", type=float, default=0.95, help="fraction 0-1")
    parser.add_argument("--max-route-p95", type=float, default=0.5, help="seconds, at the gateway")
    parser.add_argument("--max-error-rate", type=float, default=0.01)
    parser.add_argument("--out", help="write the full JSON result here")
    args = parser.parse_args(argv)

    limits = {"max_ttft_p95": args.max_ttft_p95, "max_waiting": args.max_waiting,
              "max_kv_usage": args.max_kv_usage, "max_route_p95": args.max_route_p95,
              "max_error_rate": args.max_error_rate}
    result = run(args.prometheus.rstrip("/"), args.window, limits)
    for name, series in result["checks"].items():
        print(f"{name:17} " + "  ".join(f"{k}={v}" for k, v in series.items()))
    for breach in result["breaches"]:
        print(f"BREACH  {breach}")
    print(f"slo={'PASS' if result['passed'] else 'FAIL'}")
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
