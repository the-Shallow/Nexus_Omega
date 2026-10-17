# Digital twin, doctors and the operations UI

A SimPy model of a GPU inference pod, the two doctors that diagnose and repair it, and the light-mode operations UI used for the demo. The twin powers the PRECHECK step (`simulate_action`) and covers the failure categories that are simulation-only on the live target (thermal, power, compound).

```bash
./scripts/twin.sh          # http://127.0.0.1:8765
.venv/bin/python -m pytest # twin, doctor and agent-contract tests
```

## Doctors

`nexus/doctors/` runs one controller loop (INGEST → DIAGNOSE → EXPAND_CONTEXT → PLAN → PRECHECK → ACT → VERIFY → terminal) with two tool collections:

- **Tool-Calling Doctor** engages when a replica fails the functional canary while it is healthy, serving tokens and fast. It reads the serving config, change history, raw generation and parser logs; retries a stale trace id; matches past certificates; rejects single-sided repairs by policy; and patches the parser and chat template together.
- **Infrastructure Doctor** engages on every other alarm (SLO breach, stalled replica, XID, CRAH, UPS). It localizes from `list_workers` and `inspect_facility` output only, never from the injected fault. Facility and hardware causes end `REQUIRES_APPROVAL`.

**The reasoning is a deterministic rule-based stand-in for Nemotron** (every run and certificate says so) so the loop, UI and certificates can be exercised before the agent is connected. Tool calls, actions and verification act on the twin for real. Replacing the stand-in means swapping the hypothesis and plan steps for Nemotron turns under the Checkpoint 0 contract.

Each terminal run writes a certificate to `artifacts/certificates/` (git-ignored). Certificates are matched by signature (Jaccard over symptom tokens; Nemotron Embed can replace it). `nexus/certificate/seed/` holds one labelled fixture so incident memory has a prior to match.

## UI views

| View | What it shows |
|---|---|
| Mission Control | Status, vital signs, both doctors, incidents, detection gap (dashboards vs Nexus), certificates, 3D twin, recovery timeline |
| Tool-Calling Doctor | Workflow rail and budgets, request anatomy (where the call is dropped), raw generation vs API response, per-replica serving contract and change history, reasoning and tool stream, hypotheses, incident memory, shadow test |
| Infrastructure Doctor | Rail, hypotheses, incident memory, 3D twin, shadow-twin branches (authorize when autopilot is off), reasoning and tool stream |
| Architecture | Animated pipeline and technology layer, each item marked live on Brev, built, in progress or planned |
| Domain menu | Healthcare, agriculture, education and logistics as clearly labelled concept modules |

Proof of Recovery opens from any finished run: morning summary, chat notification preview (not sent), before/after, independent checks, predicted vs actual, repair and rollback, evidence chain, JSON download and print.

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

Software agents never "fix" cooling, power or hardware. Those clear only through **Field repair** (a human action) in the Incidents panel.

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

## Recording the demo video

- Keys: `1–4` views, `B` break the system, `C` orbit, `R` reset to a healthy fleet, `space` pause, `Esc` close panels.
- The header clock shows twin time as time of day (t = 0 is 01:47:00) for the 2 AM story. Use 4× for the tool-call run (about 2.5 simulated minutes), 10× for cooling incidents.
- When a doctor engages the UI follows it automatically; a toast offers the proof when the certificate is issued.
- Suggested beats: silent tool-call failure on autopilot (canary red, dashboards green, raw vs parsed, memory match, policy rejects the single-sided fix, proof) → CRAH trip with autopilot off (shadow-twin branches, Authorize, REQUIRES_APPROVAL) → Architecture.
