# Nexus Ω — final hackathon plan

Date: October 17, 2026  
Deadline: October 18, 2026 at 11:00 AM ET  
Team: three engineers

## 1. One-sentence pitch

Nexus Ω is a Nemotron-powered SRE agent that repairs reproducible Red Hat vLLM failures, uses a SimPy shadow model to preview operational actions, and issues a recovery certificate only after the real service passes functional, performance, and safety checks.

## 2. Why this version is stronger

The attached draft contained valuable research but attempted too many systems at once. The shippable product is not a general self-healing datacenter. It is a reliable tool-calling loop for one narrow, consequential target: an LLM inference service.

The core proof is observable:

1. The service is healthy under replayed or synthetic load.
2. A real, issue-derived failure is injected.
3. Nemotron gathers evidence through typed tools.
4. The agent selects an operational repair or produces a bounded source patch.
5. Operational candidates can be previewed in SimPy; code changes run in an isolated checkout.
6. The chosen action is applied to the real target.
7. Independent verifiers decide whether recovery occurred.
8. Nexus emits `VERIFIED`, `ROLLED_BACK`, `REQUIRES_APPROVAL`, or `ABSTAIN` with evidence.

## 3. Track alignment

### Primary: Tool-Calling

The same small model must decide whether to call a tool, select it, format valid arguments, interpret failures, retry safely, verify the outcome, and abstain when no allowed action is justified.

### NVIDIA Nemotron 3.5 Lightning bounty

Use Nemotron 3.5 Lightning as the only generative decision model. Its job is execution-heavy: inspect evidence, retrieve relevant incident knowledge, call tools, and respond to verifier feedback. Use the official `nemotron_v3` reasoning parser and `qwen3_coder` tool parser when supported by the selected Red Hat vLLM image.

### NVIDIA NeMo Gym bounty

Package ServeOps as a stateful NeMo Gym environment:

- task: incident manifest plus hidden seed;
- state: isolated service/config/repository snapshot;
- actions: the exact production-like Nexus tools;
- verifier: functional recovery, SLO recovery, safety, and patch tests;
- reward: deterministic multi-component score;
- output: reproducible rollout and recovery certificate.

Training is optional. The bounty story is already meaningful if Gym runs repeatable evaluation, baselines, and ablations.

### Red Hat vLLM bounty

Run the live model-serving target and, if compatible, Nemotron itself with the Red Hat AI Inference/vLLM container. Demonstrate vLLM-specific diagnosis and repair rather than using vLLM as a logo-only dependency. Pin the exact image digest during bring-up.

## 4. System boundary

### Live target

- One small tool-capable model served by two vLLM worker processes or containers.
- A minimal team-owned gateway distributes requests and supports drain/reroute.
- Prometheus-compatible metrics or a small internal metrics endpoint.
- Structured logs and health/readiness probes.
- Docker Compose on one Brev host; no Kubernetes requirement.

Nemotron may run on a separate endpoint if serving it alongside two target workers exceeds available VRAM. The demo remains valid because the target being healed is the vLLM service, not the agent's own process.

### SimPy shadow model

SimPy models only what the demo can calibrate and explain:

- request arrivals and priority;
- gateway queue;
- worker availability and service-time distribution;
- concurrency/KV-memory pressure;
- timeout and cancellation;
- parser/tool-execution success state;
- restart, drain, reroute, throttle, and capacity changes.

It does not claim hardware-cycle, thermal, power, or network-packet fidelity. Predicted and actual outcomes must be shown side by side. Simulation confidence is low until calibration succeeds.

### Source-patch sandbox

- Check out a pinned vulnerable revision in an isolated Git worktree/container.
- Allow reads only within the incident's repository root.
- Limit patches to an allowlist, recommended maximum of three implementation files plus tests, and a diff-size cap.
- Reject dependency, workflow, secret, binary, and unrelated-file changes.
- Run the incident-specific failing test first, then focused regression tests.
- Never patch the running control plane in place.

## 5. Agent loop

```text
OBSERVE → LOCALIZE → PLAN → PRECHECK → ACT → VERIFY
    ↑                                         │
    └──────────── feedback / retry ───────────┘
                         │
              VERIFIED / ROLLED_BACK /
              REQUIRES_APPROVAL / ABSTAIN
```

The loop is a deterministic controller around Nemotron, not an unconstrained chat loop. Maximum steps, repeated-call detection, time budget, and mutation budget are enforced by code.

### Context strategy

Start with the incident symptom, service topology, recent metrics, and a small log window. Let the model request additional evidence through tools. File retrieval is symbol/path aware; it does not preload a repository. Every observation records provenance and timestamp.

### Tool groups

Read:

- `get_topology()`
- `query_metrics(metric, window, labels)`
- `read_logs(service, since, pattern, limit)`
- `read_config(service, keys)`
- `read_file(path, start_line, end_line)`
- `search_code(query, paths)`
- `retrieve_incidents(query, limit)`

Test and simulate:

- `run_canary(case_id)`
- `run_repro(incident_id)`
- `simulate_action(action, horizon, seed)`
- `run_patch_tests(test_ids)`
- `compare_slo(before_window, after_window)`

Act:

- `restart_worker(worker_id)`
- `drain_worker(worker_id)`
- `set_route_weight(worker_id, weight)`
- `set_concurrency(limit)`
- `patch_config(patch_id, changes)`
- `apply_source_patch(diff)`
- `rollback(change_id)`

Every mutating tool accepts a typed schema, validates targets against an allowlist, records before/after state, and returns a rollback token. The model never receives a generic shell tool.

## 6. Recovery certificate

Each terminal run writes JSON and a human-readable card containing:

- incident and upstream provenance;
- pinned image/revision and random seed;
- observations used;
- hypotheses considered;
- tool calls with arguments and results;
- SimPy prediction, confidence, and calibration error when used;
- actual change and rollback token;
- before/after canary, error rate, latency, and resource state;
- tests executed for a source patch;
- terminal decision and verifier reasons.

The verifier, not the language model, owns the `VERIFIED` decision.

## 7. Dataset design

The dataset is an issue-derived benchmark, not a scrape of issue text. Each upstream issue becomes one or more normalized incident episodes. Raw issue text is untrusted evidence and never instructions for the agent.

Use three episode classes:

1. `operational`: fixed through configuration, restart, reroute, throttle, or rollback;
2. `patch`: requires a small source change and tests;
3. `abstain`: evidence is insufficient or the only repair exceeds policy.

The initial candidates are in `data/issue-candidates.csv`. Promote a candidate to the benchmark only after its reproduction passes three times from a clean reset. Preserve the issue URL, repository license, issue/PR status, vulnerable revision, fix revision if known, and any adapted fixture attribution.

### Recommended six-episode MVP

1. `VLLM-59218`: non-streaming parser drops text around tool calls — CPU-only patch episode.
2. `VLLM-55530`: malformed tool JSON retry crashes before dispatch — CPU-only two-file patch episode.
3. `VLLM-54808`: required/named tool choice is silently ignored — parser/config patch episode.
4. `VLLM-22719`: warmup OOM from excessive sequence concurrency — operational configuration episode.
5. `VLLM-57650`: scheduler initialization failure leaves a worker alive — process cleanup patch/restart episode.
6. `VLLM-56943`: worker crash causes repeated traceback/log pressure — operational containment plus small patch episode.

Hold out at least two incident families from prompt/runbook examples. Split by root-cause family, not randomized paraphrase, to avoid leakage.

## 8. Evaluation

### Deterministic reward

Suggested 100-point score:

- 35: functional recovery/canary correctness;
- 20: SLO recovery within the measurement window;
- 15: root-cause classification;
- 15: safety—no forbidden mutation and rollback remains available;
- 10: action efficiency—bounded steps and no redundant mutations;
- 5: certificate completeness.

Any destructive out-of-scope action, false `VERIFIED`, or unhandled corrupted tool call caps the episode at zero.

### Baselines

- static symptom-to-playbook rules;
- Nemotron without verifier feedback;
- Nemotron with tools and verifier but without SimPy precheck;
- full Nexus loop.

### Report

Show success rate, false-verification rate, median tool calls, median recovery time, rollback rate, token usage, and simulation prediction error. With a small dataset, publish raw per-episode results rather than overstating statistical significance.

## 9. UI and demo narrative

One screen, four synchronized panels:

1. Fleet: gateway, two workers, queue, memory, health, request flow.
2. Evidence: metrics/logs/files requested by the agent.
3. Decision: current state, hypothesis, tool call, policy result.
4. Proof: simulated candidate comparison and real before/after verifier results.

Recommended live demo:

1. Run healthy tool-call canaries.
2. Inject `VLLM-22719` or a worker failure and watch queue/memory state degrade.
3. Show Nemotron diagnose and perform a bounded operational repair after SimPy precheck.
4. Show the service recover and emit a certificate.
5. Switch to `VLLM-55530`, show a malformed tool result crash, a two-file patch, focused tests, and verification.
6. End on the NeMo Gym scorecard comparing the baseline and full loop.

Do not rely on a long model download, image build, or flaky multi-GPU issue during the live presentation. Record a backup run, but keep the primary demo live.

## 10. Team split and execution order

### Engineer 1 — agent and Gym

- Typed agent loop and Nemotron client.
- Context expansion and issue retrieval.
- NeMo Gym environment, verifier, reward, baselines, and result table.

### Engineer 2 — live target and incidents

- Red Hat vLLM bring-up and pinned runtime.
- Two-worker gateway, observability, fault injection, reset, and rollback.
- Reproduce and package the operational incidents.

### Engineer 3 — SimPy, patch sandbox, and UI

- SimPy model, calibration, and candidate comparison.
- Patch worktree/container and test runner.
- Four-panel live UI and recovery-certificate presentation.

### Critical path

1. Gate 0: Nemotron makes one valid typed tool call through the chosen vLLM image.
2. Gate 1: one target worker, one injected incident, one deterministic verifier.
3. Gate 2: full observe/act/verify loop with rollback.
4. Gate 3: second worker plus operational SimPy preview.
5. Gate 4: one CPU-only source-patch episode.
6. Gate 5: Gym evaluation, UI polish, and rehearsal.

Only after Gate 2 should the team add more incident families.

## 11. Cut order

If time slips, cut in this order:

1. More than six episodes.
2. Automatic SimPy calibration; use measured parameters in a checked-in profile.
3. Source patches beyond the single malformed-JSON episode.
4. Second vLLM worker; retain a simulated second worker in the UI.
5. Training or RL.

Never cut deterministic verification, rollback, the recovery certificate, or the live end-to-end tool call.

## 12. Immediate bring-up checklist

- Record the exact Brev GPU type/count, VRAM, architecture, remaining credits, and expiry.
- Verify Docker GPU access with `nvidia-smi` inside a container.
- Obtain Red Hat registry credentials and identify the supported image tag/digest.
- Check Nemotron 3.5 Lightning compatibility with that image before designing around NVFP4.
- Pin Python 3.13.14+ for the current NeMo Gym release.
- Run a hosted Nemotron endpoint temporarily if local serving blocks Gate 0.
- Reproduce `VLLM-55530` CPU-only first; it gives a fast patching/tool-recovery vertical slice.
- Reproduce one operational incident with a small target model.

## 13. Success definition

The submission is ready when a clean-start script can launch the system and two issue-derived episodes complete end to end: one operational recovery and one bounded source patch. Both must be scored by NeMo Gym, independently verified, reversible, visible in the UI, and represented by recovery certificates.

