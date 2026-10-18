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
ssh -N -L 9090:localhost:9090 -L 8110:localhost:8110 -L 8100:localhost:8100 -L 8130:localhost:8130 nexus-omega
```

The admin API needs `NEXUS_ADMIN_TOKEN` (from `.env` on the box; ask Samarth, never commit it).

## UI server API (apps/twin)

The React app talks only to the UI server (`./scripts/twin.sh`, :8765; Vite proxies `/api` and `/ws` to it). Besides the twin's routes it now serves the real runs. The design page's [Data flow](../apps/twin/static/design.html) section draws this.

| Route | What it returns | Source |
|---|---|---|
| `GET /api/results/scoreboard` | Success / total / false VERIFIED / median time per solver × fault, grouped by the named batches in `../evidence/batches.json` (contaminated rounds never scored) | episode records |
| `GET /api/results/episodes?solver&fault&heldout` · `/api/results/episodes/{id}` | Episode rows; one full record | episode records |
| `GET /api/results/runs` · `/api/results/runs/{id}?view=snapshot\|raw` | Run list; one run as a `DoctorSnapshot` (`controller: "nemotron"`, ends with the referee's verdict) or the raw envelopes | `agent-runs/<id>/events.jsonl` + its episode |
| `GET /api/results/runs/{id}/events?after=N` · `/evidence/{ev}` · `/episode` | Envelopes after a sequence; one evidence item; the run's episode | same |
| `GET /api/results/bfcl` · `gates` · `capacity[/{name}]` · `audit?limit` | BFCL per serving profile (no per-case rows); gate summary; guidellm CSV with flattened headers; executor audit, newest first | `bfcl/`, `gates/`, `capacity/`, `harness/audit.jsonl` |
| `GET /api/runs/{id}/stream` (SSE) | Replays then follows a run. Each message: `{event, run_events}` with `id:` = sequence (EventSource resumes on its own). Then `event: referee` and `event: end` with the full snapshot | tails the trail every 0.5 s, waits for the episode |
| `WS /ws?source=live` | `hello{source:"live", topology}` then a 1 Hz frame in the twin's shape. Fields without a real source are `null`; `sources` says which feeds answered; `job` is the active Break it job | gateway admin, Prometheus, operator `/jobs` |
| `GET /api/live/status` | Which of gateway, Prometheus and the operator app answer right now | health checks |
| `GET /api/live/faults` · `POST /api/live/break {fault, solver}` · `GET /api/live/jobs[/{id}]` | Named real faults; start one as an episode (202 `{job_id}`; 409 while one runs); job state with `run_ids` to stream | operator app |

Client calls for all of these are in `apps/web/src/lib/api.ts` (`streamRun()` for the SSE stream); types in `types.ts`. The views that use them are built: the results page (`results.html`, scoreboard charts and run list), the 3D replay (`story.html?run=`), Break it live on the story page, and the landing brief.

Where results come from: with `NEXUS_OPERATOR_URL` set (e.g. `http://127.0.0.1:8130` through the tunnel) the UI server passes `/api/results/*` through to the box; otherwise it reads `ARTIFACTS_DIR` (optional local mirror) and then `../evidence/`, so everything works offline from git. Live mode also reads `NEXUS_GATEWAY_URL`, `NEXUS_PROMETHEUS_URL` and `NEXUS_ADMIN_TOKEN`. The operator token (`NEXUS_OPERATOR_TOKEN`) is set in the UI server's environment and never sent to the browser.

**Operator app** (`apps/operator/`, :8130 on the box, `./scripts/operator_up.sh`): serves the same `/runs`, `/episodes`, `/scoreboard`… routes from `artifacts/` and starts jobs. Every route needs `Bearer $NEXUS_OPERATOR_TOKEN`; faults are accepted by name only (`nexus.eval.episode.FAULTS`), one job at a time, and the executor's mutation lock still guards each repair. The agent's environment API (:8120) is unchanged and cannot reach it.

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
- [x] Operator fault endpoint for the "Break it" button (separate token, named faults only): `apps/operator/` on :8130, reached through the UI server's `/api/live/break` (see [UI server API](#ui-server-api-appstwin)).

## Status log

Newest first. One line each: date/time (ET), who, what.

- 2026-10-18 08:30 — E3 (Claude): final results on the site. Every run set has its own named batch in `../evidence/batches.json` (v1/v2 before and after, known after, temp 0.6, Nemotron 3 Super with 4 harness exclusions), and the UI server always builds the scoreboard from `evidence/`. Results page and landing brief redesigned with charts; the landing replays `run-ce0c86a3` (held-out, VERIFIED).

- 2026-10-18 01:19 — E2 (Claude): story mode at `apps/web/story.html` (code in `apps/web/src/story/`). `?run=<run-id>` (or the "Real runs" picker) replays a recorded agent run in 3D on the real 2-worker fleet, read-only from `/api/results/runs/{id}`, its opening probes and the episode: real tool calls, diagnosis, policy, executor action, referee checks and outcome, including false VERIFIED. The two scripted stories (8 illustrative replicas) stay, labelled SIMULATED. Not yet: live Break it / SSE streaming.
- 2026-10-18 00:50 — E2: real runs reach the UI server: `/api/results/*` (scoreboard, episodes, runs as `DoctorSnapshot`, BFCL, gates, capacity, audit), `/api/runs/{id}/stream` (SSE), `/ws?source=live`, and Break it via the box operator app (:8130). Client calls in `apps/web/src/lib/api.ts`; the views are still to build. Diagram in `apps/twin/static/design.html#dataflow`.
- 2026-10-17 22:50 — E2: live agent incident runs exist now. Real event trails are in `../evidence/agent/runs/` (Nemotron fixing VLLM-32926, 3/3 VERIFIED), with the evaluation log at `../evidence/agent/README.md`. The environment API is live on Brev at 127.0.0.1:8120 (read routes need `NEXUS_ENVIRONMENT_API_KEY`).
- 2026-10-17 21:20 — E2: created `web/` with this README and real samples from the live fleet. Not yet available: live agent incident runs and the fault endpoint (see "Coming from E2").
