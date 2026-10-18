# Evidence from the Brev fleet

These are small, reviewable copies of results produced on the Brev H100. The full raw outputs stay on the box under `/ephemeral/work/Nexus_Omega/artifacts/` (git-ignored), including about 109 MB of guidellm JSON.

| Path | What it is | Produced by |
|---|---|---|
| `brev-context-expansion/` | E1 handoff (E1.md sections 6–7): healthy vs VLLM-32926-broken canary, effective launch config, request trace, raw generation (deterministic replay), bounded logs. 3/3 runs matched. | `python3 -m nexus.harness.handoff --service target-a --runs 3` |
| `gates/summary.json` | Every fault-gate run: healthy → broken → recovered, per run. | `scripts/gate1.sh`, `scripts/gate_route.sh` |
| `agent/` | **Nemotron on the live fleet:** evaluation log (`agent/README.md`), every episode record including failed attempts, and each run's full event trail and evidence. VLLM-32926: 3/3 VERIFIED, 0 false VERIFIED. | `python -m nexus.eval.episode vllm-32926 --solver agent` |
| `baseline/rules-episodes.json` | Rule baseline: 12/12 on four faults, 0 false VERIFIED. | `python -m nexus.eval.episode all --solver rules --repeat 3` |
| `capacity/*.csv` | guidellm concurrency sweeps (Qwen2.5-Coder-7B, 256 tokens in / 128 out). | `scripts/load_sweep.sh` |

## Fault gates on record

| Fault | Runs | Result |
|---|---|---|
| VLLM-32926 (silent tool-call, Coder-7B) | 3 | health 200, HTTP 200, 0 parsed tool calls; rollback restores 12/12 |
| Link latency on b (Toxiproxy) | 3 | b p95 0.04 → ~1.7 s; a unaffected; gateway health 200 |
| Link blackhole on b | 3 | b 100% errors at 5.0 s; a unaffected |
| Worker b killed | 3 | b 100% errors; recovered after ~70 s relaunch |
| qwen3-4b wrong parser | 1 | HTTP 500 on every chat request (loud) |
| qwen3-4b missing auto-tool-choice | 1 | HTTP 400 on every request (loud) |

The two Qwen3-4B faults were reproduced once, on the earlier single-worker fleet. They have not yet been repeated three times.

## Capacity sweeps

| File | Setup | Peak req/s | Limit |
|---|---|---|---|
| `direct-a-baseline.csv` | 1 replica, direct, other replica idle | 42.5 (at 128 concurrent) | GPU compute |
| `sweep-2rep-coder7b.csv` | 2 replicas, Python gateway (httpx default pool) | 24.1 | 100-connection pool in the gateway |
| `gateway-ab-fixed.csv` | 2 replicas, Python gateway, pool raised | 36.5 | gateway at 100% of one CPU core |
| `haproxy-ab.csv` | 2 replicas, HAProxy | 36.1 | GPU at 100% utilization, 317 W |

Two replicas on one GPU share its compute. The second replica gives fault isolation (one can be drained while the other serves), not extra throughput.
