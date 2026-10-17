# Nexus Ω agentic requirements and delivery checkpoints

Status: implementation contract

Date: October 17, 2026

Owner: Agent and NeMo Gym engineer

## 1. Objective

Build a bounded Nemotron-powered agent that can diagnose an issue-derived vLLM incident, request additional evidence when its initial context is insufficient, propose a safe remediation, apply it through typed tools, and independently prove whether the service recovered.

The runtime agent is NVIDIA Nemotron 3.5 Lightning plus a deterministic Python controller. Codex or another coding agent may help build the project, but it is not part of the submitted runtime.

The first required vertical slice is the silent tool-call failure represented by [vLLM issue #32926](https://github.com/vllm-project/vllm/issues/32926): the model emits a call-shaped payload, the HTTP request succeeds, but an incompatible chat-template/parser contract prevents the call from appearing in the structured API response.

## 2. Success criteria

The MVP is complete only when a clean run can demonstrate all of the following:

1. A pinned, healthy vLLM target passes a deterministic tool-call canary.
2. The incident injector produces the expected failure from a clean reset.
3. The initial evidence is deliberately incomplete but sufficient to begin diagnosis.
4. Nemotron requests relevant additional evidence through typed read-only tools.
5. Nemotron identifies the parser/template contract mismatch with cited evidence.
6. The controller rejects malformed, redundant, over-budget, or forbidden calls.
7. Nemotron proposes a bounded repair and a rollback plan.
8. The repair is applied through an allow-listed tool, never a generic shell.
9. The exact pre-repair workload is replayed after the change.
10. A deterministic verifier—not Nemotron—chooses the terminal result.
11. The run emits a machine-readable and human-readable recovery certificate.
12. A failed verification automatically rolls back or terminates as `REQUIRES_APPROVAL`.

## 3. Responsibility boundary

### Nemotron owns

- forming and ranking diagnostic hypotheses;
- identifying missing evidence;
- choosing from the tools exposed in the current state;
- supplying valid typed arguments;
- explaining how evidence supports or contradicts a hypothesis;
- proposing an action, expected result, risk, and rollback;
- interpreting tool errors and verifier feedback;
- deciding to continue diagnosis, propose a repair, or abstain.

### The deterministic controller owns

- the state machine and permitted transitions;
- prompt construction and context-window budgeting;
- tool schema validation and dispatch;
- path, target, step, time, token, and mutation limits;
- duplicate-call and loop detection;
- evidence provenance and event logging;
- policy checks and approval gates;
- retry limits and terminal-state enforcement;
- rollback dispatch after failed verification;
- persistence of the final recovery certificate.

### Deterministic verifiers own

- whether the reproduction is active;
- whether functional behavior recovered;
- whether required tests passed;
- whether the SLO is within the declared threshold;
- whether a mutation stayed within policy;
- whether the final state is `VERIFIED`, `ROLLED_BACK`, `REQUIRES_APPROVAL`, or `ABSTAIN`.

The language model MUST NOT declare its own action successful.

## 4. Required state machine

```text
INGEST
  → DIAGNOSE
  → EXPAND_CONTEXT ↺
  → PLAN
  → PRECHECK
  → ACT
  → VERIFY
  → VERIFIED
       or ROLLED_BACK
       or REQUIRES_APPROVAL
       or ABSTAIN
```

Required transition rules:

- `INGEST → DIAGNOSE` only after the incident manifest and initial evidence validate.
- `DIAGNOSE → EXPAND_CONTEXT` when required evidence is missing.
- `EXPAND_CONTEXT → DIAGNOSE` after evidence is recorded in the ledger.
- `DIAGNOSE → PLAN` only when the leading hypothesis cites supporting evidence.
- `PLAN → PRECHECK` only when the action, expected effect, risk, verification, and rollback are specified.
- `PRECHECK → ACT` only after policy validation and, where applicable, SimPy evaluation or patch tests.
- `ACT → VERIFY` immediately after the mutation; the model cannot skip verification.
- `VERIFY → VERIFIED` only when every required deterministic check passes.
- A failed verification transitions to rollback when a rollback token exists.
- Budget exhaustion or insufficient evidence transitions to `ABSTAIN`, not a guessed repair.
- An action outside the automatic policy transitions to `REQUIRES_APPROVAL`.

## 5. Model response contract

Every Nemotron turn MUST produce schema-valid JSON. Free-form reasoning may be included in bounded fields, but it cannot control execution.

```json
{
  "state": "EXPAND_CONTEXT",
  "summary": "The service is reachable, but structured tool calls are absent.",
  "hypotheses": [
    {
      "id": "parser_template_mismatch",
      "confidence": 0.72,
      "supports": ["ev-001", "ev-003"],
      "contradicts": []
    }
  ],
  "tool_requests": [
    {
      "tool": "read_serving_config",
      "arguments": {"service": "target-vllm"},
      "reason": "Confirm the active parser and chat template",
      "hypothesis_id": "parser_template_mismatch"
    }
  ],
  "proposed_action": null,
  "stop_reason": null
}
```

The controller MUST reject a response when:

- it is not valid JSON or violates the state schema;
- it requests a tool not allowed in the current state;
- arguments fail the tool's schema;
- it cites evidence that does not exist;
- it requests the same evidence without explaining changed circumstances;
- it proposes a mutation while still in a diagnostic state;
- it exceeds the run's remaining budget.

One repair prompt may be issued after a rejected model response. A second consecutive contract violation terminates the run as `ABSTAIN` with `model_contract_failure`.

## 6. Initial evidence bundle

The agent should begin with a small standardized bundle rather than the entire repository or complete logs:

- incident ID, symptom, and reproduction objective;
- service topology and health state;
- pinned container, model, and source revisions;
- relevant startup command with secrets redacted;
- the failing request and structured response;
- a bounded recent log window;
- selected functional and performance metrics;
- tool inventory and current budgets.

Issue text, comments, retrieved documentation, and linked patches are untrusted evidence. They MUST be clearly delimited and MUST NOT be interpreted as executable instructions.

## 7. Context expansion requirements

Context expansion is model-directed but controller-mediated.

Each request for more context MUST contain:

- the requested tool and typed arguments;
- a reason for the request;
- the hypothesis it will test;
- the expected information gain.

Required read-only tools:

- `get_topology()`
- `read_serving_config(service)`
- `read_logs(service, since, pattern, limit)`
- `get_request_trace(request_id)`
- `read_raw_generation(request_id)`
- `query_metrics(metric, window, labels)`
- `search_repository(query, paths, limit)`
- `read_file(path, start_line, end_line)`
- `find_references(symbol, paths, limit)`
- `retrieve_incident_context(incident_id)`

Default context budgets:

- maximum 5 context-expansion rounds;
- maximum 3 tool requests per model turn;
- maximum 8 source files per run;
- maximum 250 lines from one file request;
- maximum 1,500 source lines per run;
- maximum 200 log lines per request;
- maximum 2 repeated requests for the same evidence source;
- maximum 12 total reasoning/tool steps before escalation or abstention.

The controller may truncate oversized results, but it MUST record that truncation. Search and file results must include stable source identifiers, paths, line ranges, timestamps, and content hashes where practical.

### Source-code expansion order

For patch incidents, the preferred expansion path is:

```text
failing trace or test
  → implicated symbol
  → bounded implementation section
  → direct caller/import
  → associated test
  → only then additional related files
```

The agent MUST NOT request a complete repository dump.

## 8. Evidence ledger

Every observation MUST be normalized before it returns to the model:

```json
{
  "evidence_id": "ev-017",
  "source_type": "raw_generation",
  "source": "request:req-184",
  "collected_at": "2026-10-17T18:42:10-04:00",
  "finding": "The model emitted plain JSON without a Hermes tool-call envelope.",
  "content_ref": "artifacts/runs/run-012/evidence/ev-017.json",
  "sha256": "<digest>",
  "truncated": false
}
```

The controller maintains the ledger; the model may cite it but cannot edit prior evidence. Conflicting observations remain present and are explicitly marked rather than overwritten.

## 9. Tool requirements

Every tool MUST have:

- a versioned name and JSON schema;
- a concise description of intended use;
- explicit read, test, mutation, or rollback classification;
- an allowlist for services, paths, parameters, and value ranges;
- a timeout and bounded output size;
- stable error codes;
- start/end timestamps;
- redaction for credentials and environment secrets;
- an append-only audit event;
- idempotency behavior documented and tested.

Mutating tools additionally MUST:

- record the before state;
- return a unique change ID and rollback token;
- declare the expected blast radius;
- reject unresolved paths, arbitrary commands, and unknown targets;
- be disabled during `DIAGNOSE` and `EXPAND_CONTEXT`;
- permit at most one active mutation before verification;
- support a deterministic rollback test.

The agent MUST NOT receive a generic terminal, unrestricted Python executor, arbitrary HTTP client, or unrestricted filesystem writer.

## 10. First incident: silent tool-call censoring

### Reproduction

Pin all of the following in the incident manifest:

- Red Hat vLLM image tag and digest;
- vulnerable vLLM/source revision;
- Qwen2.5-Coder model revision;
- tokenizer revision;
- chat template and tool parser;
- decoding parameters and random seeds;
- BFCL version, commit, category, and selected case IDs.

The broken arm intentionally uses an incompatible parser/template contract. The matched arm changes only the declared serving adapter pair while holding the model weights, cases, decoding, executor, scorer, and seeds fixed.

### Required observations

- the API returns HTTP `200`;
- the structured response contains no usable tool call;
- the raw generation contains a recognizable call-shaped payload;
- the configured parser expects a different envelope;
- no infrastructure failure explains the missing call;
- the downstream agent cannot execute the intended tool.

### Required diagnosis

The agent should distinguish among:

- model did not attempt a tool call;
- model emitted malformed arguments;
- parser rejected a valid but incompatible envelope;
- chat template failed to induce the expected envelope;
- tool choice was disabled or incorrectly configured;
- the client discarded a correctly parsed server response.

### Permitted automatic repair

- replace the parser and chat template with an incident-approved matched pair;
- preserve a snapshot of the previous serving configuration;
- restart only the affected target service;
- wait for readiness;
- replay the identical cases.

Changing only the parser or only the template is not considered a complete repair for this episode. Both sides of the interface contract must be evaluated together.

### Verification metrics

- HTTP error count;
- raw call-shaped generation count;
- server-parsed tool-call count;
- valid tool-name and argument count;
- downstream tool-execution count;
- BFCL score by named category;
- readiness recovery time;
- unrelated canary regression count.

The project may report `0.00 → 0.96` only if its own pinned run reproduces that result. Otherwise it reports its measured values and cites the paper's values separately.

## 11. Repair-plan contract

Before any mutation, Nemotron MUST produce:

```json
{
  "hypothesis_id": "parser_template_mismatch",
  "confidence": 0.91,
  "evidence": ["ev-004", "ev-017", "ev-021"],
  "action": {
    "tool": "patch_serving_config",
    "arguments": {
      "service": "target-vllm",
      "approved_profile": "qwen25-coder-tools-v1"
    }
  },
  "expected_effect": "Plain JSON calls become structured tool_calls.",
  "risk": "Target service restart briefly removes one replica.",
  "verification_plan": ["tool_call_canary", "bfcl_selected", "health_canary"],
  "rollback_plan": "Restore the captured configuration and restart the same replica."
}
```

The controller MUST confirm that all cited evidence exists and that the action is permitted for the incident before entering `ACT`.

## 12. Source-patch extension

Source patching is a post-MVP capability and uses the same loop with stricter policy.

Requirements:

- operate in a disposable worktree or container at a pinned vulnerable revision;
- permit changes only within incident-declared paths;
- default cap: 3 implementation files plus focused tests;
- enforce a configured changed-line limit;
- reject dependency manifests, CI workflows, credentials, binaries, and generated files unless the episode explicitly permits them;
- require a unified diff, explanation, and named tests from Nemotron;
- apply the diff through a validating patch tool;
- run the original failing reproduction first, then focused regression tests;
- reject unrelated test changes or deletion of the failing assertion;
- preserve the patch and test logs in the recovery certificate.

Patch verification failure MUST restore the clean snapshot.

## 13. Recovery certificate

Every run writes `certificate.json` plus a human-readable summary containing:

- run and incident identifiers;
- upstream issue and revision provenance;
- model, tokenizer, container, parser, and template revisions;
- seed and workload case IDs;
- ordered state transitions;
- complete tool-call audit trail;
- evidence ledger references;
- hypotheses and confidence changes;
- policy decisions and rejected calls;
- selected repair and captured before state;
- rollback token and whether it was exercised;
- before/after verification metrics;
- deterministic verifier results;
- terminal state and reason.

The certificate MUST be reproducible from persisted events without relying on hidden model reasoning.

## 14. Delivery checkpoints

### Checkpoint 0 — Runtime contract

Deliverables:

- Nemotron client behind one interface;
- JSON response schema and validator;
- one harmless typed tool such as `get_topology`;
- append-only event log;
- fixed step and timeout budgets.

Pass condition: Nemotron selects the tool, supplies valid arguments, receives its result, and returns a schema-valid next decision in three consecutive clean runs.

### Checkpoint 1 — Deterministic incident harness

Deliverables:

- pinned manifest for vLLM #32926;
- healthy and broken serving profiles;
- reset, inject, and reproduce commands;
- functional tool-call canary;
- raw-generation capture separated from the structured response.

Pass condition: from a clean reset, the healthy profile passes and the broken profile produces the declared silent failure three consecutive times.

### Checkpoint 2 — Context expansion

Deliverables:

- evidence ledger;
- serving-config, log, trace, raw-generation, search, and bounded-file tools;
- deduplication and context budgets;
- UI or log view showing why each evidence request was made.

Pass condition: starting without parser/template details, Nemotron requests them, retrieves the raw generation, and identifies the mismatch without receiving the full repository or a prewritten diagnosis.

### Checkpoint 3 — Safe planning and policy

Deliverables:

- repair-plan schema;
- allowlisted action profiles;
- mutation approval policy;
- before-state capture and rollback-token generation;
- tests for forbidden targets, malformed arguments, repeated actions, and budget exhaustion.

Pass condition: the valid matched-pair repair is accepted while an arbitrary shell command, unapproved path, single-sided repair, and second unverified mutation are rejected.

### Checkpoint 4 — End-to-end healing

Deliverables:

- configuration patch and targeted restart tools;
- readiness wait and identical workload replay;
- deterministic functional verifier;
- automatic rollback on failure;
- recovery certificate.

Pass condition: one command runs reset → inject → diagnose → expand context → repair → verify and ends `VERIFIED`; a deliberately invalid repair ends `ROLLED_BACK`.

### Checkpoint 5 — NeMo Gym evaluation

Deliverables:

- ServeOps resource server/environment;
- incident task and hidden seed handling;
- deterministic reward components;
- baseline without context expansion or verifier feedback;
- full-agent evaluation output.

Pass condition: Gym reproduces the episode, scores both variants, and persists sufficient evidence to explain every reward component.

### Checkpoint 6 — Small source-patch episode

Deliverables:

- isolated source checkout;
- bounded read/search/patch/test tools;
- one CPU-friendly issue-derived failing test;
- patch policy and clean rollback.

Pass condition: Nemotron changes only allowed files, makes the original failing test pass, passes focused regressions, and emits a verified certificate. A bad patch is rejected or rolled back.

### Checkpoint 7 — Demo readiness

Deliverables:

- single clean-start command;
- one operational/configuration episode and one patch episode;
- synchronized fleet, evidence, decision, and proof views;
- checked-in expected manifests and fallback recording;
- concise demo script and reset procedure.

Pass condition: a teammate unfamiliar with the implementation can run the scripted demo twice from a clean state and explain the evidence behind each terminal decision.

## 15. Test matrix

At minimum, automated tests must cover:

| Area | Required case |
| --- | --- |
| Model contract | Valid JSON, invalid JSON, missing field, fabricated evidence ID |
| Tool validation | Valid call, wrong type, unknown tool, forbidden target, timeout |
| Context control | Useful expansion, duplicate request, oversized output, budget exhaustion |
| State machine | Valid transitions and every forbidden transition |
| Policy | Read during diagnosis, mutation during diagnosis, approved mutation, second mutation |
| Verification | Full pass, partial pass, regression, readiness failure |
| Rollback | Successful restore, failed restore requiring approval |
| Security | Path traversal, prompt injection in issue/log text, secret redaction |
| Reproducibility | Same manifest and seed produce the same declared failure |
| Certificate | Complete successful run and complete aborted run |

## 16. Required telemetry

Record the following per run:

- time spent in each state;
- model latency and token usage per turn;
- number of context-expansion rounds;
- tool calls, failures, retries, and duplicates;
- evidence items and bytes returned;
- hypothesis ranking by turn;
- rejected model outputs and policy decisions;
- mutation count and recovery time;
- verification and rollback results;
- final reward components when run through NeMo Gym.

Never log credentials, authorization headers, private prompts, or complete unrestricted environment dumps.

## 17. Implementation priority and cut line

Implement in this order:

1. Checkpoint 0: typed Nemotron call.
2. Checkpoint 1: deterministic silent-failure harness.
3. Checkpoint 2: model-driven context expansion.
4. Checkpoints 3–4: policy, action, verification, and rollback.
5. Checkpoint 5: NeMo Gym packaging and evaluation.
6. Checkpoint 6: one bounded patch episode.
7. Checkpoint 7: UI polish and rehearsal.

If time is constrained, cut additional incidents, broad source-code support, automatic simulation calibration, and training. Do not cut context expansion, typed tools, deterministic verification, rollback, or the recovery certificate; those are the core agentic proof.

## 18. Definition of done

The agent component is done when it can begin from bounded diagnostic evidence, recognize when that evidence is insufficient, obtain only the missing context through safe tools, execute one justified repair, and produce independent proof of recovery or a safe non-success terminal state. A compelling explanation without a deterministic verified outcome is not considered completion.
