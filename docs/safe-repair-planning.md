# Safe repair planning

The runtime accepts a model-proposed repair only as structured data. Nemotron
cannot execute the proposal. The deterministic controller validates its evidence,
evaluates it against an allow-list, captures the target's current configuration,
and creates rollback identifiers before entering `PRECHECK`.

## Repair-plan contract

A `PLAN` response may include:

```json
{
  "hypothesis_id": "parser-contract",
  "confidence": 0.95,
  "evidence": ["ev-001", "ev-002", "ev-003"],
  "action": {
    "tool": "patch_serving_config",
    "arguments": {
      "service": "target-a",
      "approved_profile": "qwen-tools-matched-v1"
    }
  },
  "expected_effect": "Structured tool calls are parsed successfully.",
  "risk": "The target service requires a bounded restart.",
  "verification_plan": ["readiness", "visible_tool_canary"],
  "rollback_plan": "Restore the captured launch configuration."
}
```

Every cited evidence ID must exist and support the named hypothesis. Arbitrary
tools, extra action arguments, direct paths, single-sided parser changes, unknown
profiles, and malformed plans are rejected before target state is read.

## Policy and precheck

`RepairPolicy` permits only `patch_serving_config(service, approved_profile)`.
Profiles contain a reviewed parser/template pair, so the model selects a named
repair rather than constructing arbitrary configuration. Services outside the
automatic allow-list transition to `REQUIRES_APPROVAL`.

For an approved proposal, `RepairPrecheck`:

1. verifies the plan's evidence and hypothesis relationship;
2. reads the redacted effective launch configuration;
3. records it as the before-state;
4. creates a unique change ID and rollback token;
5. reserves one active repair until verification clears it;
6. transitions the runtime from `PLAN` to `PRECHECK`.

No mutation tool is implemented at this stage. `PRECHECK` means the proposal is
authorized and reversible, not that it has been applied.

## Verification

Run:

```bash
python -m unittest discover -s tests -v
```

The policy tests cover an approved matched profile, arbitrary shell, an
unapproved service, direct and single-sided configuration changes, fabricated or
unrelated evidence, before-state capture, rollback-token creation, and a second
repair while the first remains unverified.
