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

The generic `nexus.app` runtime still ends at planning or precheck. The
issue-scenario runner has an opt-in isolated source executor:
`python -m scripts.run_issue_scenarios --vllm-repo <path> --candidate VLLM-59218 --execute-repair`.
That flag supplies operator approval for the non-automatic action. A second
model turn proposes exact text edits from cited source evidence. The executor
checks path, file hash, worktree state, edit size, and unique match before
writing. It reruns the declared probe and rolls the worktree back if the
regression contract fails. `PRECHECK` alone still does not prove a repair ran.
