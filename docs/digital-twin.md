# Digital twin, doctors and the operations UI

A SimPy model of a GPU inference pod, the two doctors that diagnose and repair it, and the NEXUS Ω platform UI used for the demo. The twin powers the PRECHECK step (`simulate_action`) for its own rule-based doctors and covers the failure categories that are simulation-only on the live target (thermal, power, compound). The live Nemotron agent on the Brev fleet does not consult it.

```bash
./scripts/twin.sh          # http://127.0.0.1:8765 (builds apps/web once if npm is available)
.venv/bin/python -m pytest # twin, doctor and agent-contract tests

cd apps/web && npm install
npm run dev                # http://127.0.0.1:5173, hot reload, proxies the twin on :8765
npm run build              # writes apps/web/dist, which the twin server serves at /
```

`/platform.html` serves the React platform when `apps/web/dist` exists (`/` is the story landing page); the previous light-mode views stay at `/classic`.

## Doctors

`nexus/doctors/` runs one controller loop (INGEST → DIAGNOSE → EXPAND_CONTEXT → PLAN → PRECHECK → ACT → VERIFY → terminal) with two tool collections:

- **Tool-Calling Doctor** engages when a replica fails the functional canary while it is healthy, serving tokens and fast. It reads the serving config, change history, raw generation and parser logs; retries a stale trace id; matches past certificates; rejects single-sided repairs by policy; and patches the parser and chat template together.
- **Infrastructure Doctor** engages on every other alarm (SLO breach, stalled replica, XID, CRAH, UPS). It localizes from `list_workers` and `inspect_facility` output only, never from the injected fault. Facility and hardware causes end `REQUIRES_APPROVAL`.

**The reasoning here is a deterministic rule-based stand-in** (every run and certificate says so). It drives only the simulated scene; tool calls, actions and verification act on the twin. The real agent on the Brev fleet is Nemotron 3.5 Lightning (`nexus/agent/`, `nexus/harness/agent_run.py`), and its runs are episode records and event trails in `evidence/`, not certificates.

Each terminal run writes a certificate to `artifacts/certificates/` (git-ignored). Certificates are matched by signature (Jaccard over symptom tokens). `nexus/certificate/seed/` holds one labelled fixture so incident memory has a prior to match.

## Platform UI (`apps/web`)

One dark, single-page view (React, TypeScript, Tailwind, Framer Motion, a WebSocket store, and a Three.js twin with bloom). The digital twin fills the screen; everything else floats over it in glass.

| Element | What it shows |
|---|---|
| Header | Data source (LIVE / SIMULATED / REPLAY), system status, simulation time with play, pause and 1× / 4× / 10×, a menu (autopilot, overview camera, replay last incident, reset), **Break the system** |
| Break the system | Glass overlay of the 9 failure scenarios grouped by category, each with its known-issue id, whether a real episode exists on Brev, and which doctor answers |
| Twin | Racks, GPUs (heat-colored), replicas, fibre routes lit by replica state, cooling, power, airflow, request and response packets. Faults add a shockwave, a marker and a callout; rack outlines take the worst state of their nodes; a verified repair sends a green wave through the hall |
| Recovery timeline | Detect → Investigate → Select tools → Simulate → Repair → Verify, mapped from the doctor states, with the latest step's real event below |
| Panels (collapsed by default) | Incident (signal, class, hypotheses, memory, evidence), Tool calls (every call with arguments, reason and raw result), Recovery (shadow-twin race, applied actions, independent checks, field repair) |
| Outcome | Opens when the run ends: the path the run took through the system, then the recovery certificate (outcome seal, time to detect and close, dashboards alerted, prediction error, checks, evidence, repair, sha256, JSON download, replay) |

The doctor is never chosen in the UI: the backend routes each signal to the Tool-Calling or Infrastructure Doctor. A recovery shows as verified only when the certificate says `VERIFIED`; `ROLLED_BACK`, `REQUIRES_APPROVAL` and `ABSTAIN` are shown as they are.

Data modes: **SIMULATED** is the SimPy twin. **LIVE** is not connected to this view (the header says so); the real fleet is shown on the story page (Break it live and recorded replays), and the UI server's `/ws?source=live` feed reads the tunnelled gateway, Prometheus and operator app (web/README.md). **REPLAY** plays back a recorded incident (pre-roll, fault, run, a few seconds after), recorded in the browser.

## What is modeled

| Layer | Model | Code |
|---|---|---|
| Traffic | Poisson arrivals with a diurnal swing; log-normal prompt/output lengths; 35% tool calls | `model.py` `_arrivals` |
| Gateway | Weighted routing, health checks every 2 s, optional token-bucket throttle and per-worker in-flight caps | `_dispatch`, `_health_loop` |
| vLLM replica | Continuous batching at 100 ms steps: chunked prefill budget, TPOT that grows with batch size, KV-cache accounting with recompute preemption, 30 s client timeout | `_step_worker` |
| GPU | Utilization → power (idle to TDP), first-order thermal (R_th, τ), thermal slowdown above 87 °C, power capping, XID 48/79/94 | `_physics` |
| Rack | Inlet from supply air plus recirculation; exhaust from ΔT = P / (ρ·c_p·airflow); single-feed power budget water-filled across GPUs | `_physics` |
| Room | CRAH capacity against IT load drives supply-air temperature; PUE from cooling COP and fan power | `_physics` |
| Verification | Functional tool-call canary every 5 s; SLO = TTFT p95 ≤ 1 s, TPOT p95 ≤ 25 ms, errors ≤ 1%, canary 100% | `_canary_loop`, `kpis` |

Topology and parameters live in `nexus/simulator/profiles/pod-h100.json`: 2 rows × 8 racks × 4 nodes × 8 H100 (512 GPUs), 8 vLLM replicas, the rest batch training. **The profile is uncalibrated** (`confidence: low`, shown in the UI). Replace the serving and thermal parameters with values measured on the Brev target before quoting predictions.

## Faults

Each chaos card links to its row in `data/infra_candidate_csv.csv` (the infrastructure taxonomy; `issue-candidates.csv` is the agent benchmark shortlist). The badge shows the execution mode planned for that category in the CSV (REAL EPISODE / HYBRID / SIM-ONLY); it is not a record of a run. The faults actually run on the fleet are the 12 in `nexus/eval/episode.py`, with every episode in `evidence/`. Everything inside the twin itself is simulated, and the header says so.

| Fault | Candidate | Expected best fix (from preview) |
|---|---|---|
| Hung worker | controlled `docker pause` | drain → restart → re-admit after canary |
| Worker crash | VLLM-56943 | drain → restart → re-admit |
| Silent tool-call failure | VLLM-32926 | drain wave, matched parser/template pair 2 at a time, re-admit |
| Burst overload | VLLM-18826 | throttle (sheds load; nothing meets SLO at 3×) |
| ToR degradation | NETEM-GATEWAY | drain workers on the rack |
| CRAH trip | DCGM-720 | pause batch jobs (all rows) |
| UPS feed loss | simulated | cap batch GPUs to 250 W |
| GPU XID 79 | NVIDIA-XID-48-79-94 | cordon + escalate (restart crash-loops) |
| Thermal → XID cascade | COMPOUND-… | pause batch, then field repair |

Software agents never "fix" cooling, power or hardware. Those clear only through **Record field repair** (a human action) in the Recovery panel, or **Field repair** in the classic Incidents panel.

## API (for the agent's tools)

| Endpoint | Purpose |
|---|---|
| `POST /api/preview {horizon, candidates?}` | `simulate_action`: fork the live twin and run each candidate under 3 seeds. Returns ranked candidates with min/median/max bands. |
| `GET /api/candidates` | Runbook candidates for the open incidents |
| `POST /api/actions {kind, args}` | `restart_worker`, `drain_worker`, `set_route_weight`, `set_concurrency`, `throttle`, `patch_config`, `set_power_limit`, `pause_batch`, `resume_batch`, `cordon_node`, `uncordon_node`. Returns a change token. |
| `POST /api/rollback {token}` | Undo a reversible change (restarts are irreversible) |
| `POST /api/faults {kind, target?}` · `POST /api/faults/{id}/repair` | Inject / field-repair |
| `GET /metrics` | Prometheus text with DCGM (`DCGM_FI_DEV_*`) and vLLM (`vllm:*`) names, labelled `source="twin"` |
| `WS /ws` | 10 Hz frames, plus the active doctor run whenever it changes |
| `GET /api/doctors` · `POST /api/doctors/config {autopilot}` | Doctor status; autopilot off stops runs at PRECHECK |
| `POST /api/doctors/runs/{id}/approve {choice}` | Authorize a candidate (`recommended` or an id) or `reject` |
| `GET /api/certificates` · `GET /api/certificates/{id}[?download=1]` · `GET /api/certificates/{id}/summary` | Certificate list, JSON, and the notification and morning-summary renderings |

## Controls (platform page)

- Keys: `B` break the system (then `1–9` to pick a failure), `space` play/pause, `O` overview camera, `Esc` close overlays. Reset is in the `⋯` menu.
- The camera flies to each new fault, stays out of the way of the panels, and returns home after a verified repair. The hall orbits slowly when nothing is happening.
- The header clock shows twin time as time of day (t = 0 is 01:47:00) for the 2 AM story. Use 4× for the tool-call run (about 2.5 simulated minutes), 10× for cooling incidents.
- **Replay last incident** (menu or certificate) replays a recorded run for retakes, with its own speed control and a violet frame so it is never mistaken for live.
- `window.nexus.twin.get()` exposes camera presets (`preset('top' | 'cold' | 'hot' | 'power' | 'network')`) for scripted shots.
