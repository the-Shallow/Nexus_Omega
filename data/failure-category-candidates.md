# Failure-category issue candidates

Reviewed: 2026-10-17

## Reproduction standard

An upstream issue is an **exact reproduction** only when the run records and matches its material environment: vulnerable revision or image digest, model revision, accelerator class, GPU count/topology, driver/CUDA/PyTorch versions, launch arguments, workload, and failure signature. Merely producing another OOM or timeout does not reproduce the issue.

Use these labels in every manifest and UI card:

| Label | Meaning |
| --- | --- |
| `exact_reproduction` | Original material environment and trigger are matched. |
| `hardware_gated` | Exact only if the Brev hardware/topology matches. |
| `controlled_real_fault` | A real fault is induced safely, without claiming the original environment. |
| `simulated_telemetry` | An event is injected as data; any mirrored container/load action is real and separately identified. |

Before selection, save:

```bash
nvidia-smi
nvidia-smi topo -m
docker version
uname -a
```

Also save the container digest, model commit, vLLM commit/tag, and complete launch command.

## Category mapping

### 1. GPU and hardware failures

Primary H100 candidates:

- [vLLM #16886](https://github.com/vllm-project/vllm/issues/16886): one-H100 concurrency/batched-token OOM with Qwen2.5-3B. Use only after pinning the issue's full software configuration.
- [vLLM #47069](https://github.com/vllm-project/vllm/issues/47069): open, exceptionally strong H100 reproduction. The report pins one H100 80 GB SXM, RHEL 8, vLLM 0.19.0, Qwen2.5-0.5B, and a concurrent replay that diverges on FlashAttention 3 but is clean on FA2/TRITON.

XID 48/79/94 must be simulated from [NVIDIA's XID semantics](https://docs.nvidia.com/deploy/xid-errors/archive/index.html). Inject the event into telemetry, drain the corresponding real replica, and label the hardware event simulated. Never deliberately induce PCIe or ECC damage.

### 2. Compute and worker failures

- [vLLM #56943](https://github.com/vllm-project/vllm/issues/56943): open, model/backend-independent worker-crash traceback amplification. Prefer the deterministic CPU/unit reproducer; optionally demonstrate the same behavior with a controlled worker kill.
- [vLLM #57650](https://github.com/vllm-project/vllm/issues/57650): open worker-leak failure after scheduler initialization fails. The original report uses an aarch64 Ascend environment, so an NVIDIA adaptation is not an exact reproduction unless a common core test is isolated and clearly relabeled.
- Hung worker: `docker pause` is a controlled real fault, not a GitHub reproduction. Verify it using an inference canary rather than process liveness alone.

### 3. Memory and resource management

Use #16886 as the H100 issue-derived base. Create separate controlled variants for KV pressure, excessive concurrency, and a bounded noisy-neighbor allocator. The noisy-neighbor recovery policy may reroute or lower concurrency; it must not kill an arbitrary process.

### 4. Network and communication failures

- [vLLM #45078](https://github.com/vllm-project/vllm/issues/45078): closed, explicit distributed-timeout/TP reproduction. The original environment has eight RTX 6000 Ada GPUs, although the trigger uses TP=2. Treat it as a stretch exact reproduction.
- Gateway latency, loss, refusal, and timeout should use Toxiproxy or `tc netem` as `controlled_real_fault` episodes. Record the impairment parameters and do not claim they reproduce #45078.

Avoid multi-node issues requiring 16 H100s for the live demo.

### 5. Inference and tool-calling failures

- [vLLM #55530](https://github.com/vllm-project/vllm/issues/55530): open, CPU-only malformed JSON retry crash; best small source-patch episode.
- [vLLM #59218](https://github.com/vllm-project/vllm/issues/59218): closed, CPU parser reproduction plus optional Qwen3-0.6B server; best streaming/non-streaming semantic parity episode.
- [vLLM #54808](https://github.com/vllm-project/vllm/issues/54808): closed, silent failure to enforce required/named/none tool choice; strong semantic-canary alternate.

### 6. Performance and workload failures

- [vLLM #18826](https://github.com/vllm-project/vllm/issues/18826): open RFC documenting the unbounded waiting queue. Generate a controlled real overload with a small model and verify queue length, p95 TTFT, rejection/throttle behavior, and recovery.
- [vLLM #57680](https://github.com/vllm-project/vllm/issues/57680): open 3.3x decode-throughput regression, but exact reproduction requires an H100 NVL confidential-computing VM and Qwen3.6-35B-A3B-FP8. Use only if Brev matches.

### 7. Power, cooling, and thermal failures

These are simulation-only. Emit real DCGM field names, including GPU temperature, power usage, SM clock, thermal/power violation, and XID. [dcgm-exporter #720](https://github.com/NVIDIA/dcgm-exporter/issues/720) supplies current provenance for correlating power limits with reduced clocks and inference latency.

The correct action is drain, reroute, throttle, or escalate. A software agent must never claim it repaired cooling, power delivery, PCIe, or an ECC fault.

### 8. Cascading and compound failures

Compose already validated component episodes:

```text
simulated thermal violation
  -> simulated XID on GPU/worker A
  -> real drain or stop of worker A
  -> real traffic shift to worker B
  -> real queue and TTFT degradation
  -> optional real #54808/#59218-style tool canary failure
```

The expected terminal result is normally `DEGRADED_BUT_STABLE` or `REQUIRES_APPROVAL`, not `VERIFIED`, because the infrastructure condition remains unresolved.

## Recommended eight-episode release set

1. `VLLM-16886` if the Brev instance is H100; otherwise replace it with a hardware-matched OOM issue.
2. `VLLM-56943` worker crash/log amplification.
3. Controlled hung worker or `VLLM-57650` only under its correctly labeled environment.
4. Controlled gateway latency/packet loss.
5. `VLLM-55530` malformed tool JSON patch.
6. `VLLM-59218` parser semantic failure.
7. `VLLM-18826` queue/TTFT overload.
8. Simulated DCGM thermal/XID event mirrored into a real worker drain.

Add `VLLM-47069` when an H100 80 GB is available. Build the compound episode only after all of its component verifiers pass independently.

## Promotion gate

A candidate enters the benchmark only after:

1. Three clean resets reproduce the expected failure.
2. Three clean fixed/control runs pass.
3. Injector and cleanup are idempotent.
4. The verifier distinguishes failure, repair, rollback, and false success.
5. Provenance and licensing are recorded.
6. The UI accurately labels real versus simulated evidence.
