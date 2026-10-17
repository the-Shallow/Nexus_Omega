# Nexus Ω

**One small model keeps an AI inference service healthy. It finds failures that dashboards miss, previews repairs before applying them, and proves that recovery happened.**

Submission for the NVIDIA × Red Hat Small Models Hack (Raleigh, October 17–18, 2026). **Track: Tool-Calling.**

> **Status:** in active development during the hackathon. Sections marked *planned* describe intended behavior that has not yet been verified. Measured results will appear in [Results](#results) only after they are produced.

---

## The problem

Teams that self-host open models on vLLM rely on health checks and latency dashboards. Many of the failures that matter most never show up there:

- **Silent tool-calling failures.** The server returns `200 OK`, but a parser, flag, or chat-template mismatch discards the model's tool call. The agent built on the endpoint stops working, and no alert fires. One documented case moved a model's BFCL score from 0.00 to 0.96 by fixing the serving configuration alone (arXiv 2609.03966).
- **Workers that look healthy but do no work.** A hung worker still answers `/health` while its throughput drops to zero.
- **Capacity failures.** KV-cache pressure, startup OOM, and concurrency limits that only appear under real traffic.
- **Serving-code defects.** Parser and lifecycle bugs reported upstream in vLLM.

Existing tools mostly stop at detection. Nexus Ω carries the incident through **diagnosis, a bounded repair, and independent verification**, and it abstains when no safe repair exists.

## What Nexus Ω does

```text
OBSERVE → LOCALIZE → PLAN → PRECHECK → ACT → VERIFY
    ↑                                         │
    └──────────── feedback / retry ───────────┘
                         │
     VERIFIED · ROLLED_BACK · REQUIRES_APPROVAL · ABSTAIN
```

1. **Observe.** Replayed production traffic runs against a live vLLM service. Functional canaries check that tool calls actually work, beyond the server simply responding.
2. **Localize.** NVIDIA Nemotron 3.5 Lightning chooses typed tools to inspect metrics, logs, configuration, model files, and, when needed, specific lines of source code.
3. **Precheck.** A SimPy shadow model, calibrated from the live service's own metrics, estimates how each candidate operational action would perform before anything touches the real service.
4. **Act.** The runtime applies one bounded change: a restart, drain, reroute, concurrency limit, configuration patch, or a small source patch in an isolated checkout. Every change has a rollback token.
5. **Verify.** Independent verifiers (functional canaries, hidden canaries, SLO checks, patch tests) decide the outcome. The language model never declares its own success.
6. **Certify.** Each run produces a Recovery Certificate: the evidence used, the tool calls made, the predicted vs. actual effect, the before/after measurements, and the rollback data.

## Incident classes

| Class | Examples | Typical repair | Fault injection |
|---|---|---|---|
| **Tool-call correctness** | Parser/model mismatch, missing `--enable-auto-tool-choice`, chat template without tools, tool call swallowed by the reasoning parser | Configuration patch, then canary verification | Edit flags or template, then restart |
| **Process health** | Worker crash, hung worker, orphaned worker after a failed init (VLLM-57650) | Restart, drain, reroute | `docker kill`, `docker pause` |
| **Capacity** | Warmup OOM from excessive concurrency (VLLM-22719), KV-cache pressure under burst load | Concurrency limit, route weights, throttle | Memory and concurrency settings, burst replay |
| **Network** | Latency or packet loss between the gateway and one worker | Reroute, report degraded link | Toxiproxy / `tc netem` |
| **Serving-code defects** | Malformed tool JSON crashes the retry path (VLLM-55530), parser drops text (VLLM-59218) | Small source patch plus focused tests | Pinned vulnerable revision |
| **Abstain** | Model variant without tool support; repair exceeds policy | `REQUIRES_APPROVAL` or `ABSTAIN` | Fixture |

Candidate upstream incidents are listed in [`data/issue-candidates.csv`](data/issue-candidates.csv). An incident joins the benchmark only after three clean reproductions from reset.

## Architecture

```text
 Traffic replay (guidellm)          Fault injector (UI "Break")
          │                                   │
          ▼                                   ▼
   Gateway (drain / reroute) ──▶ vLLM workers (Red Hat AI Inference image)
          │                                   │
          └──────── metrics, logs ────────────┤
                                              ▼
                              Prometheus + DCGM exporter
                                              │
   Nemotron 3.5 Lightning ◀──▶ Tool runtime (FastAPI: read · test · act · rollback)
   (vLLM, agent)                     │              │
                                     │              ├─▶ SimPy shadow model (precheck)
   Nemotron Embed ──▶ incident /     │              ├─▶ Patch sandbox (pinned checkout, tests)
   runbook retrieval                 ▼              └─▶ Verifiers ──▶ Recovery Certificate
                              NeMo Gym environment (episodes, reward, baselines)
                                              │
                              UI: Fleet · Evidence · Decision · Proof
```

Everything runs with Docker Compose on a single NVIDIA Brev GPU host. The agent's endpoint is kept separate from the service it repairs, so a broken target never disables the agent.

## Technology

| Component | Role in the system |
|---|---|
| **NVIDIA Nemotron 3.5 Lightning** (30B total / 3B active) | The only generative model. It selects tools, interprets evidence, and responds to verifier feedback. Served with the `qwen3_coder` tool parser and `nemotron_v3` reasoning parser. |
| **Red Hat AI Inference Server (vLLM)** | Serves the agent and the target service. The target is also what Nexus Ω diagnoses and repairs. |
| **NVIDIA NeMo Gym** | ServeOps environment: incident tasks, the production tool set, a deterministic verifier and reward, baselines and ablations. |
| **NVIDIA Brev** | GPU host for the full stack. |
| **NVIDIA DCGM exporter** | Real GPU telemetry for the agent and the UI. |
| **Nemotron Embed** | Retrieval over incident manifests and runbooks. As an embedding model it falls outside the generative parameter limit. |
| **guidellm** (vLLM project) | Replays real request traces and measures before/after SLOs. |
| **LLM Compressor** (Red Hat) | Produces a quantized worker the agent can shift load to under memory pressure. |
| **SimPy** | Shadow model of request flow, queueing, worker availability and KV pressure. |
| **Prometheus, FastAPI, Toxiproxy, Docker Compose** | Observability, tool runtime, network fault injection, orchestration. |
| **NVIDIA Dynamo** *(optional)* | KV-aware router, used only if it runs reliably on the single host. The team-owned gateway is the default. |

## Model parameter budget

The competition limits all generative models in the product to **≤ 33B total parameters**.

| Model | Role | Counted |
|---|---|---|
| Nemotron 3.5 Lightning | Agent | **Yes: ~32B total** |
| Nemotron Embed | Retrieval | No (embedding model) |
| Small target model(s), e.g. Qwen3-4B | The service under repair | No (test target, per organizer guidance) |

No other generative model is used for judging, summarization, routing, or speculative decoding. All verification is deterministic code.

## Data and provenance

| Source | License | Use |
|---|---|---|
| [vLLM](https://github.com/vllm-project/vllm) issues and pull requests | Apache-2.0 | Incident episodes (`data/issue-candidates.csv`) |
| [Azure LLM inference traces 2024](https://github.com/Azure/AzurePublicDataset) | CC-BY | Production traffic replay |
| [BurstGPT](https://github.com/HPMLL/BurstGPT) | CC-BY-4.0 | Burst replay; real failure rates |
| [BFCL](https://github.com/gorilla-llm/gorilla/tree/main/berkeley-function-call-leaderboard) | Apache-2.0 | Tool-call canary prompts |
| [NVIDIA XID catalog](https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html) | NVIDIA documentation | GPU error runbook |
| [Llama 3 paper, Table 5](https://arxiv.org/abs/2407.21783) | Citation | Real-world fault-frequency reference |

Issue text is treated as untrusted evidence. It is never executed as an instruction. Each adapted fixture keeps its upstream URL, license and revision.

## Evaluation

- **Environment:** ServeOps on NeMo Gym, split by root-cause family. At least two families are held out from prompts and runbooks.
- **Baselines:** static symptom-to-playbook rules; Nemotron without verifier feedback; Nemotron without the SimPy precheck; the full Nexus loop.
- **Metrics:** verified-recovery rate, false-verification rate, root-cause accuracy, correct abstention, tool calls and time to recovery, rollback rate, SimPy prediction error.
- **Reporting:** per-episode raw results. No significance claims are made on a small benchmark.

## Results

*To be added after evaluation runs. No figures are reported before they are measured.*

## Repository layout (planned)

```text
apps/api/            FastAPI control plane and event stream
apps/ui/             Fleet, Evidence, Decision and Proof views
nexus/agent/         Controller, prompts, context selection, policy
nexus/tools/         Typed read / test / act / rollback tools
nexus/simulator/     SimPy shadow model and candidate evaluator
nexus/verifier/      Functional, SLO, patch-test and safety checks
nexus/certificate/   Recovery certificate
environments/serveops/  NeMo Gym resource server, tasks, verifier
incidents/<id>/      Manifest, injector, fixture, oracle, cleanup
runtime/compose/     Gateway, vLLM workers, metrics, UI
runtime/redhat-vllm/ Pinned Red Hat image configuration
data/                Incident catalog and splits
evals/               Baselines, ablations, held-out runs
scripts/             Bring-up, smoke test, demo, reset
docs/                Architecture, runbook, demo script, decisions
```

## Quick start (planned)

```bash
cp .env.example .env              # model IDs, ports, registry credentials
./scripts/bring_up.sh             # start agent endpoint, target workers, gateway, metrics
./scripts/smoke_test.sh           # canaries pass on the healthy service
./scripts/demo.sh VLLM-22719      # inject an incident and run the Nexus loop
gym eval run ...                  # ServeOps evaluation (see environments/serveops)
```

Exact commands and pinned image digests will be filled in at bring-up.

## Team and responsibilities

| Engineer | Area | Owns |
|---|---|---|
| **E1: Agent & Evaluation** | ML | Nemotron serving and client, the controller and tool schemas, context and incident retrieval, NeMo Gym environment, reward, baselines, ablations, results |
| **E2: Live Target & Incidents** | Systems / networking | Brev host, Red Hat vLLM bring-up, gateway, Prometheus/DCGM, fault injection, reset and rollback, operational incident reproduction, canaries and SLO verifiers, guidellm traffic replay |
| **E3: Shadow Model, Patch Sandbox & UI** | Simulation / UI | SimPy model and calibration, candidate comparison, isolated patch worktree and test runner, the four-panel UI, Recovery Certificate view, demo video |

**Milestones**
1. **Gate 0:** Nemotron makes a valid typed tool call through the chosen vLLM image.
2. **Gate 1:** one target worker, one injected incident, one deterministic verifier.
3. **Gate 2:** full observe → act → verify loop with rollback.
4. **Gate 3:** second worker plus SimPy precheck.
5. **Gate 4:** one source-patch episode.
6. **Gate 5:** NeMo Gym evaluation, UI polish, rehearsal.

The detailed plan, cut order and checklist are in [`docs/hackathon-plan.md`](docs/hackathon-plan.md). The runtime contract and checkpoint acceptance criteria are in [`docs/agentic-requirements.md`](docs/agentic-requirements.md).

## Known limitations

- The SimPy shadow model covers request flow, queueing, KV-cache pressure, and lumped GPU power, thermal and room-cooling behavior. It does not model network packets, and its parameters are uncalibrated until measured on the live target.
- Source patches are limited to small, allowlisted changes against a pinned revision in an isolated checkout.
- Some upstream incidents are adapted to the available GPU and a smaller model; each adaptation is labelled.
- Single-host deployment. Kubernetes and multi-node serving (llm-d, multi-node Dynamo) are out of scope for the hackathon.

## Next steps

- Larger incident catalog across more vLLM versions and model families.
- Kubernetes deployment with llm-d.
- Training the agent on its own episode history in NeMo Gym.

## License

To be confirmed by the team. Upstream fixtures keep their original licenses.
