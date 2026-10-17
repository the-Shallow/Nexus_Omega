# Brev target interface (for the E1 diagnostic backend)

Values for `E1.md` section 4, plus the harness pieces E2 provides so the
`DiagnosticBackend` adapter stays thin. All commands run on the Brev host from
`/ephemeral/work/Nexus_Omega` with `.env` loaded.

## Target values

```text
TARGET_BASE_URL=http://localhost:8101          # worker a direct; the gateway is http://localhost:8100
TARGET_MODEL=qwen25-coder                      # served name; Qwen/Qwen2.5-Coder-7B-Instruct @ c03e6d3
TARGET_SERVICE_ID=target-a                     # target-b = worker b on :8102 (behind Toxiproxy at the gateway)
TARGET_CONTAINER_OR_PROCESS=nexus-a
TARGET_HEALTH_URL=http://localhost:8101/health
TARGET_LOG_SOURCE=nexus.harness.inspect.bounded_logs("target-a", since, pattern, limit)
TARGET_CONFIG_SOURCE=nexus.harness.inspect.effective_launch_config("target-a")
TARGET_TRACE_SOURCE=nexus.verifier.canary.run_case(..., raw=True)   # structured response of the visible case
TARGET_RAW_GENERATION_SOURCE=nexus.verifier.canary.raw_generation   # deterministic replay, see below
RESET_COMMAND_OR_API=python3 -m nexus.target.manager apply a qwen25-coder-7b.tools-template
INJECT_COMMAND_OR_API=python3 -m nexus.target.manager apply a qwen25-coder-7b.vllm-32926
```

- **Image:** `vllm/vllm-openai:v0.27.1@sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967`.
- **Healthy profile:** `qwen25-coder-7b.tools-template`. This is the `qwen2_5_coder` parser plugin from PR vllm#32931 plus the `<tools>` chat template.
- **Broken profile:** `qwen25-coder-7b.vllm-32926`. This is `hermes` with the model's default template. Only the parser/template pair differs between the two.
- The approved repair profile for `RepairPolicy` is `qwen25-coder-7b.tools-template`. It is the only profile with `kind: healthy` for this model.

## Raw generation caveat

vLLM does not return a request's text from before the parser runs. To get it, `canary.raw_generation` renders the identical prompt with the server's own template (`/tokenize`), then generates from those token IDs at temperature 0 with no parser (`/v1/completions`).

This is real model output for the same input, but it comes from a **second request**. The handoff labels it `capture: "deterministic_replay"` and records whether it matches the structured `content`. (Under the broken profile, `content` holds the whole unparsed generation.)

## Harness modules E2 provides

| Need | Module | Notes |
|---|---|---|
| Effective launch config | `nexus.harness.inspect.effective_launch_config(service)` | Read from `docker inspect` of the running container. Returns parser, template, plugin, revision, auto-tool-choice and image digest. No environment; arguments are redacted. |
| Bounded logs | `nexus.harness.inspect.bounded_logs(service, since, pattern, limit)` | `since` must look like `30s`/`10m`/`2h`; `limit` ≤ 200; lines are redacted and capped at 500 characters; returns a `truncated` flag. |
| Visible canary | `nexus.verifier.canary.BUILTIN_CASES["single_call"]` + `run_case(..., raw=True)` | Only this case may be exposed as `visible_tool_call`. |
| Applying a repair | `nexus.harness.executor.patch_serving_config(service, approved_profile)` | Call this after `PRECHECK`. It takes the lock, checks that another worker is still serving, drains, applies, runs the **hidden** canary (`runtime/canaries/hidden.jsonl`), then undrains or rolls back. Returns `VERIFIED`, `ROLLED_BACK`, `REQUIRES_APPROVAL` or `REJECTED`, and appends to `artifacts/harness/audit.jsonl`. |
| Other actions | `restart_worker`, `drain_worker`, `undrain_worker` in the same module | The rule baseline uses these. Add them to `RepairPolicy` if Nemotron should have them too. |

Hidden canaries are never reachable through the inspect module or the visible canary.

## Handoff artifacts

`python3 -m nexus.harness.handoff --service target-a --runs 3` writes `artifacts/brev-context-expansion/`:
- `environment.md`
- `healthy-canary.json`, `broken-canary.json`
- `launch-config.json`
- `request-trace.json`
- `raw-generation.json`
- `bounded-logs.json`
- `reproduction.md`
- `runs.json`

The script resets, injects and restores worker a while worker b keeps serving.
