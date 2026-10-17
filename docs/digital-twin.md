# Digital twin (SimPy shadow model)

A SimPy model of a GPU inference pod with a live 3D view. It powers the PRECHECK step (`simulate_action`) and covers the failure categories that are simulation-only on the live target (thermal, power, compound).

```bash
./scripts/twin.sh          # http://127.0.0.1:8765
.venv/bin/python -m pytest # model tests
```

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

Each chaos card links to its row in `data/failure-category-candidates.csv`. The badge tells the viewer whether a real episode exists on the live target (REAL EPISODE / HYBRID) or the category is simulation-only (SIM-ONLY). Everything inside the twin itself is simulated, and the header says so.

| Fault | Candidate | Expected best fix (from preview) |
|---|---|---|
| Hung worker | controlled `docker pause` | drain → restart → re-admit after canary |
| Worker crash | VLLM-56943 | drain → restart → re-admit |
| Silent tool-call failure | VLLM-54808 | drain wave, rolling parser patch, re-admit |
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
| `WS /ws` | 10 Hz frames for the 3D view |

## Recording the demo video

- Keys: `1–7` camera views (overview, cold aisle, hot aisle, plenum, top, power, network), `C` cinematic orbit, `T` thermal overlay, `L` labels, `H` hide the HUD for clean shots, `P` preview, `space` pause.
- Speed buttons (1× / 4× / 10×) compress thermal incidents; the CRAH scenario takes about 3 simulated minutes to breach.
- Previews older than 15 s are re-forked automatically before a candidate is applied, so the predicted band and the white "actual" line start from the same state.
- Suggested beats: hung worker (dashboards green, canary red) → silent tool-call failure → CRAH trip from the hot-aisle view, preview, apply, recovery.
