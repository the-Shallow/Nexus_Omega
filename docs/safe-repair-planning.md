# Safe repair planning

The model proposes a repair; it never receives a mutation capability. A repair
uses the stable controller-level form:

```json
{
  "tool": "apply_action",
  "arguments": {
    "action_id": "apply-serving-profile",
    "target": "target-a",
    "parameters": {"profile": "qwen-tools-matched-v1"}
  }
}
```

The meaning and parameter schema of `action_id` come from the environment
manifest. This allows a serving environment, database lab, queue system, or
other target to declare different safe actions without changing agent code.

`RepairPolicy` rejects undeclared actions, targets, fields, and parameter
values. Actions marked `automatic: false` transition to `REQUIRES_APPROVAL`.
For an automatic action, `RepairPrecheck` verifies evidence linkage, reads only
the action's declared `before_state_keys`, rejects unredacted sensitive data,
creates change and rollback identifiers, and reserves one active repair.

No mutation executor exists yet. `PRECHECK` means the plan is allowed and its
rollback inputs were captured; it does not mean the action was applied.
