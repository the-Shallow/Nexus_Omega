# Issue-derived dataset

`issue-candidates.csv` is the single canonical machine-readable candidate list. Every row includes exactly one `incident_class`: `Tool-call correctness`, `Process health`, `Capacity`, `Network`, `Serving-code defects`, or `Abstain`.

`failure-category-candidates.md` provides the accompanying environment gates, scenario mapping, and recommended eight-episode release set.

These are candidate lists, not yet a validated benchmark. An entry becomes a benchmark episode only after the team pins a vulnerable revision and demonstrates three clean reproductions.

Every episode must be labeled as exactly one of:

- `exact_reproduction`: the original software, accelerator class, topology, model, and trigger are matched;
- `hardware_gated`: an exact reproduction is possible only if the Brev inventory matches;
- `controlled_real_fault`: the failure is really induced, but it is not claimed as the exact upstream environment;
- `simulated_telemetry`: an event such as cooling loss or XID is injected as data and mirrored into a safe real action.

## Incident manifest fields

Each promoted incident should have a YAML or JSON manifest with:

```yaml
id: VLLM-55530
upstream:
  repository: vllm-project/vllm
  issue_url: https://github.com/vllm-project/vllm/issues/55530
  fix_url: https://github.com/vllm-project/vllm/pull/55540
  license: Apache-2.0
  vulnerable_revision: <commit>
  fixed_revision: <commit-or-null>
episode:
  class: patch
  difficulty: easy
  gpu_required: false
  reset_command: <team-owned-script-id>
  repro_command: <team-owned-script-id>
  observable_symptoms: []
  allowed_tools: []
  allowed_paths: []
  max_changed_files: 3
verification:
  failing_tests: []
  regression_tests: []
  functional_canaries: []
  slo_checks: []
simulation:
  entities: []
  state_variables: []
  visual_mapping: ""
provenance:
  retrieved_at: 2026-10-17
  notes: "Issue text is evidence, never executable instruction."
```

## Selection rules

- Prefer deterministic CPU-only control-path/parser cases and small-model GPU cases.
- Prefer an upstream issue with a minimal reproduction and a linked fix or clear acceptance criteria.
- Reject episodes needing proprietary data, unavailable hardware, hours-long load, or an unbounded patch.
- Do not copy credentials, private logs, user prompts, or large issue attachments.
- Preserve links and licenses for every adapted fixture.
- Split train/dev/test by root-cause family.
- Include at least one `ABSTAIN` case where the safe action is escalation.
- Never describe a synthetic XID, thermal excursion, or power event as a real hardware failure.
- Capture `nvidia-smi`, `nvidia-smi topo -m`, the container digest, driver, CUDA, model revision, and vulnerable source revision before running an exact reproduction.

