# Issue-derived dataset

`issue-candidates.csv` is a researched candidate list, not yet a validated benchmark. An entry becomes a benchmark episode only after the team pins a vulnerable revision and demonstrates three clean reproductions.

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

