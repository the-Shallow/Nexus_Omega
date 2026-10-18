# Digital twin, doctors and the operations UI

A SimPy model of a GPU inference pod, the two doctors that diagnose and repair it, and the NEXUS Ω platform UI used for the demo. The twin powers the PRECHECK step (`simulate_action`) and covers the failure categories that are simulation-only on the live target (thermal, power, compound).

```bash
./scripts/twin.sh          # http://127.0.0.1:8765 (builds apps/web once if npm is available)
.venv/bin/python -m pytest # twin, doctor and agent-contract tests

cd apps/web && npm install
npm run dev                # http://127.0.0.1:5173, hot reload, proxies the twin on :8765
npm run build              # writes apps/web/dist, which the twin server serves at /
```

`/` serves the React platform when `apps/web/dist` exists, and the older static view when it does not (no npm needed).

## Doctors

`nexus/doctors/` runs one controller loop (INGEST → DIAGNOSE → EXPAND_CONTEXT → PLAN → PRECHECK → ACT → VERIFY → terminal) with two tool collections:

- **Tool-Calling Doctor** engages when a replica fails the functional canary while it is healthy, serving tokens and fast. It reads the serving config, change history, raw generation and parser logs; retries a stale trace id; matches past certificates; rejects single-sided repairs by policy; and patches the parser and chat template together.
- **Infrastructure Doctor** engages on every other alarm (SLO breach, stalled replica, XID, CRAH, UPS). It localizes from `list_workers` and `inspect_facility` output only, never from the injected fault. Facility and hardware causes end `REQUIRES_APPROVAL`.

**The reasoning is a deterministic rule-based stand-in for Nemotron** (every run and certificate says so) so the loop, UI and certificates can be exercised before the agent is connected. Tool calls, actions and verification act on the twin for real. Replacing the stand-in means swapping the hypothesis and plan steps for Nemotron turns under the Checkpoint 0 contract.

Each terminal run writes a certificate to `artifacts/certificates/` (git-ignored). Certificates are matched by signature (Jaccard over symptom tokens; Nemotron Embed can replace it). `nexus/certificate/seed/` holds one labelled fixture so incident memory has a prior to match.

## Platform UI (`apps/web`)

One dark, single-page War Room: React, TypeScript, Tailwind, Framer Motion, a WebSocket store, and two Three.js scenes with bloom (the twin and the recovery architecture). There is no page navigation: War Room → Break → the hall takes the hit → the architecture assembles → verify → certificate → replay or a new failure. Every transition follows a real state change: a fault in the twin's frames, a doctor run's events, or the timeline of a recorded run.

| Element | What it shows |
|---|---|
| Floating dock | The Ω mark and NEXUS, system state (Nominal, Incident, Investigating, Repairing, Verifying, Verified, Rolled back, Requires approval, Abstained; only signals monitoring can see), the one data mode in effect (SIMULATED / REPLAY / LIVE), simulation or replay time with play, pause and 1× / 4× / 10× (hidden in LIVE), a menu (autopilot, domains, reset) and a compact **Break** |
| War Room | A large holographic screen above the hall: a live topology (users and agents → gateway → the 8 replicas, facility underneath; particles move with real traffic), four health signals with history (TTFT p95, errors, tool-call canary, capacity), what the doctors are doing, and **Break the system**. It flags stale or lost frames. During a fleet replay it shows the recorded fleet instead (HAProxy, `target-a`, `target-b`, route probes, executor, referee) |
| Twin | Foreground, brightly lit (sky fill, key, blue-white rim), fixed isometric camera with slight pointer parallax. It never flies to a failure: a fault gets concentric alarm rings on the floor, a red or amber pulse and a small tag. Click any component for a glass capsule with its health and 2–3 metrics |
| Break the system | A sheet that grows out of the trigger. Rows grouped by **Tool-Calling Doctor** and **Infrastructure Doctor**, each labelled SIMULATED (injected into the twin through `POST /api/faults`), REPLAY ONLY (recorded Nemotron runs on the Brev fleet) or NOT IMPLEMENTED (listed, not selectable). Nothing is LIVE INJECTABLE: the fleet's fault endpoint is not connected |
| Recovery architecture | After a short incident beat the hall and War Room shrink to the left and the full architecture assembles on the right as 3D glass modules: demand → gateway → vLLM replicas (real ids and health) on GPUs, network, cooling and power → telemetry → one controller → Tool-Calling / Infrastructure Doctor → shadow twin → policy gate → act → verify → outcome → certificate. A module appears only when the run reaches it or an event makes it relevant (the failure landing on it, a tool reading it, a repair changing it); its connector grows first. Tool calls and repairs arc over the board to what they touch, and thin traces link that module to the component in the hall. When the run ends, unused modules appear as ghosts and the branch actually taken (VERIFIED, ROLLED BACK, REQUIRES APPROVAL, ABSTAIN) is lit. Click a module for its calls, arguments, results and timestamps. Phones get the same run as a compact list |
| Certificate | Revealed from the certificate module when the run ends, never opened automatically: incident id, source, tool collection, timeline, rollback, trace, the terminal state (green only for an independently verified success), before → after, checks, actions, evidence. **Download JSON** and **Download PDF** come from the same stored record |
| After the certificate | Replay simulation (or recording; no new calls), Start new failure (resets the twin, waits for the backend, reopens the chooser), Run again (twin only: a fresh twin and a new execution by the rule-based stand-in, never a replay) |

The doctor is never chosen in the UI: the backend routes each signal to a tool collection, both driven by one controller. Twin runs say "rule-based stand-in · Nemotron not connected". In a recorded fleet run the controller used one tool registry; the architecture groups its calls by what they inspect. A run shows as verified only when its record says `VERIFIED`, and a recorded run the referee did not confirm shows as FALSE VERIFIED.

Data modes:
- **SIMULATED**: the SimPy twin. Cooling and power are a virtual facility; shadow-twin results are labelled *predicted*.
- **REPLAY**: either an incident recorded in the browser from the twin, or a **real-fleet recording**, i.e. a run of Nemotron 3.5 Lightning on the Brev fleet loaded from `evidence/agent/`. The twin recedes during a fleet replay. The clock shows recorded UTC time. Long silent gaps, such as the executor's ~75 s restart, are skipped faster, and the UI says so whenever it happens.
- **LIVE**: reserved for production telemetry. It is not connected in this build.

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

Each chaos card links to its row in `data/infra_candidate_csv.csv` (the infrastructure taxonomy; `issue-candidates.csv` is the agent benchmark shortlist). The badge tells the viewer whether a real episode exists on the live target (REAL EPISODE / HYBRID) or the category is simulation-only (SIM-ONLY). Everything inside the twin itself is simulated, and the header says so.

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

Software agents never "fix" cooling, power or hardware. Those clear only through **Record the technician's field repair** (a human action), offered next to the outcome when a run ends with one still open.

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
| `GET /api/certificates/{id}/pdf` | The same certificate as a PDF (`nexus/certificate/pdf.py`, standard library only) |
| `GET /api/recordings` · `GET /api/recordings/{run_id}` | Recorded Nemotron runs on the real fleet (`nexus/recordings.py`): each agent trail, its evidence, and its referee-scored episode, paired by `run_id` or by time. `NEXUS_RECORDINGS_DIR` overrides `evidence/agent` |
| `GET /api/recordings/{run_id}/record.json[?download=1]` · `GET /api/recordings/{run_id}/certificate.pdf` | The recording as one JSON record, and its certificate as a PDF |

## Recording the demo video

- Keys: `B` opens Break the system (`↑ ↓` and `Enter` or `1–9` to pick, `Esc` to close), `space` plays or pauses the simulation or the replay. Reset is in the `⋯` menu.
- The camera is fixed. The hall shrinks and moves left when the workflow appears, and recenters when you close the workflow or start a new failure.
- The dock clock shows twin time as time of day (t = 0 is 01:47:00) for the 2 AM story. Use 4× for the tool-call run (about 2.5 simulated minutes) and 10× for cooling incidents.
- Suggested beats:
  1. Silent tool-call failure on autopilot. The warning tags read `200 OK · tool_calls: []`, the canary drops, dashboards never alert, the workflow grows, then the certificate.
  2. Real fleet: in Break the system → Real fleet, replay the latest verified run. Nemotron's actual tool calls appear, the executor repairs `target-a` and the referee confirms the fix.
  3. CRAH trip with autopilot off. Authorize in the Shadow Test module; the run ends "service verified · facility needs a human"; then record the field repair.
- `window.nexus.fleet.start('run-8bf1324b')` starts a fleet replay from the console for scripted shots.
