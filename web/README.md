# web/ — Nexus Ω frontend (shared)

This is the shared folder for the UI and its API. **E3 owns the design and code here.** E2 (Samarth) owns the fleet, faults, executor and environment API that this folder reads from. **Both of us keep this README current.** Add a line to the [status log](#status-log) when something lands or changes.

## What the UI should show

The demo is one incident, end to end, on a real fleet:

1. **Silent fault:** worker `a` starts dropping tool calls. Its `/health` stays 200 and HTTP stays 200, but the tool-call canary fails. That gap is the pitch.
2. **The doctor investigates:** each tool call Nemotron makes and what it got back, e.g. launch config shows `tool_call_parser: hermes`; raw output shows a `get_weather` call the parser ignored.
3. **The repair:** drain `a` → apply the approved profile → hidden canary passes → undrain. Users keep being served by `b` throughout. Measured once: 1,550 requests, 0 errors.
4. **The scoreboard:** rule baseline vs Nemotron (and a large reference model) on the same episodes; capacity findings.

## Boundary: read freely, change nothing directly

| E3 may | Only through an E2 endpoint |
|---|---|
| Read Prometheus, the admin API (GET), and the files below; build any read-only API, dashboard, twin or event stream on top | Anything that changes the fleet: injecting a fault ("Break it" button), drain/undrain, applying a profile |

The fault-injection endpoint E2 will provide uses a separate operator token and named faults only, and the agent can never reach it. That separation is part of the security story judges asked about. Please don't call `docker`, the manager, the fault injectors or the executor from UI code.

## Getting at the data

Everything runs on the Brev box `nexus-omega`. Ports are bound to localhost there, so forward them:

```bash
ssh -N -L 9090:localhost:9090 -L 8110:localhost:8110 -L 8100:localhost:8100 nexus-omega
```

The admin API needs `NEXUS_ADMIN_TOKEN` (from `.env` on the box; ask Samarth, never commit it).

## Data sources

| Source | How | What you get | Sample |
|---|---|---|---|
| **Prometheus** | `GET http://localhost:9090/api/v1/query?query=<PromQL>` (also `query_range`) | Live metrics, below | `samples/prometheus-*.json` |
| **Fleet routing** | `GET http://localhost:8110/admin/workers` with `Authorization: Bearer $NEXUS_ADMIN_TOKEN` | Per worker: `weight`, `drained`, `status`, `requests`, `errors`, `active`, `queued` | `samples/admin-workers.json` |
| **Workers** | `python -m nexus.target.manager status` on the box | Per worker: `worker`, `port`, `profile`, `container` (running/exited) | `samples/manager-status.json` |
| **Agent run trail** | `artifacts/agent-runs/<run_id>/events.jsonl` on the box (append-only, one JSON per line) | Ordered events: `run_started`, `model_turn_validated` (tool calls chosen), `tool_completed` (tool result), `decision_reformat_requested`, `decision_validated`, `repair_plan_evaluated`, `run_completed` / `run_failed` | `samples/agent-events.capability-smoke.jsonl` (smoke test; real incident runs have the same envelope) |
| **Repair actions** | `artifacts/harness/audit.jsonl` on the box | One record per executor action: `action`, `service`, `status` (VERIFIED / ROLLED_BACK / REQUIRES_APPROVAL / REJECTED / APPLIED), `before` (launch config), `verification` (hidden canary), `seconds` | `samples/executor-audit.jsonl`, `samples/executor-repair-verified.json` |
| **Episode results** | `artifacts/episodes/*.json` on the box; summaries in `evidence/` in git | Fault, solver, terminal state, success, false-VERIFIED, action, time, referee verdict | `samples/episode.vllm-32926.rules.json`, `../evidence/baseline/rules-episodes.json` |
| **Capacity / gates** | `../evidence/capacity/*.csv`, `../evidence/gates/summary.json` | Throughput vs concurrency; every fault reproduction | — |

Event envelope: `{"event_type", "payload", "run_id", "sequence", "timestamp"}`. `sequence` is gap-free per run, so tail by sequence.

### Useful PromQL

| Panel | Query |
|---|---|
| Time to first token, p95, per worker | `histogram_quantile(0.95, sum by (instance, le) (rate(vllm:time_to_first_token_seconds_bucket[1m])))` |
| Requests waiting, per worker | `vllm:num_requests_waiting` |
| KV-cache use, per worker | `vllm:kv_cache_usage_perc` |
| Worker up (scraping) | `up{job="vllm"}` |
| Route latency at HAProxy (moving average) | `haproxy_server_total_time_average_seconds{proxy="vllm"}` |
| Route errors at HAProxy | `rate(haproxy_server_connection_errors_total{proxy="vllm"}[1m])` |
| GPU utilisation / power / temperature | `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_POWER_USAGE`, `DCGM_FI_DEV_GPU_TEMP` |

`instance` is `nexus-a:8000` / `nexus-b:8000`; HAProxy's `server` label is `a` / `b`. The agent itself (`nexus-agent:8000`) is scraped too.

## Fleet at a glance

- `nexus-a`, `nexus-b`: two identical Qwen2.5-Coder-7B workers (the "patients"), behind HAProxy on `:8100`. `b` is reached through Toxiproxy so network faults can be injected on its link.
- `nexus-agent`: Nemotron 3.5 Lightning (the "doctor") on `:8103`.
- One H100. The two workers share its compute, so the second worker provides isolation, not extra speed.
- Faults with 3/3 reproductions: VLLM-32926 silent tool-call (on `a`), link latency on `b`, link blackhole on `b`, worker `b` killed. See `../evidence/README.md`.

## Coming from E2

- [x] Environment API (`apps/environment/`): manifest-driven read API the agent uses. Read-only routes are also usable by the UI (`ssh -L 8120:localhost:8120`).
- [x] Live agent runs on the fleet. Real incident trails are in `../evidence/agent/runs/`; new ones land in `artifacts/agent-runs/` on the box.
- [ ] Operator fault endpoint for the "Break it" button (separate token, named faults only).

## Status log

Newest first. One line each: date/time (ET), who, what.

- 2026-10-17 23:45 — E3: the platform UI (`apps/web`, served by the twin server at `/`) now replays the real agent runs in `../evidence/agent/` as REPLAY · real fleet. The runs come from `GET /api/recordings[/{run_id}]` (`nexus/recordings.py`), and certificates download as JSON and PDF. Still read-only: no fleet changes from the UI until E2's operator fault endpoint exists.
- 2026-10-17 22:50 — E2: live agent incident runs exist now. Real event trails are in `../evidence/agent/runs/` (Nemotron fixing VLLM-32926, 3/3 VERIFIED), with the evaluation log at `../evidence/agent/README.md`. The environment API is live on Brev at 127.0.0.1:8120 (read routes need `NEXUS_ENVIRONMENT_API_KEY`).
- 2026-10-17 21:20 — E2: created `web/` with this README and real samples from the live fleet. Not yet available: live agent incident runs and the fault endpoint (see "Coming from E2").
