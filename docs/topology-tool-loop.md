# Topology tool loop

This smoke workflow proves that the deterministic controller can expose a typed
tool to Nemotron, validate the model's native tool call, return the tool result,
validate the model's next structured decision, enforce hard budgets, and record
an append-only audit trail.

## Included

- `NemotronClient` protocol so the controller is independent of the endpoint provider.
- Dependency-free `VLLMNemotronClient` for a Nemotron model served by Red Hat vLLM.
- Native `tool_calls` decoding and argument validation.
- Strict decision contract mirrored in `schemas/agent-decision.schema.json`.
- One read-only, zero-argument `get_topology` tool.
- Fixed step, tool-call, and wall-clock budgets.
- Append-only JSONL events with stable run IDs and sequence numbers.
- Scripted smoke mode for controller testing without a model endpoint.
- Live mode for the actual Nemotron gate.

## Verify locally

From the repository root:

```powershell
python -m unittest discover -s tests -v
python -m scripts.topology_smoke_test --mode scripted --runs 3
```

The smoke run must report three runs, each with:

- `state: DIAGNOSE`
- `steps: 2`
- `tool_calls: 1`

Event logs are written under `artifacts/topology-smoke-test/` and intentionally ignored by Git.

## Verify with Nemotron

Point the adapter at the vLLM endpoint without committing credentials:

```powershell
$env:NEMOTRON_BASE_URL = "http://<host>:<port>/v1"
$env:NEMOTRON_MODEL = "<served-model-name>"
$env:NEMOTRON_API_KEY = "<key-if-required>"
python -m scripts.topology_smoke_test --mode live --runs 3
```

For a local endpoint without authentication, omit `NEMOTRON_API_KEY`.

The live contract is passed when live mode completes three consecutive runs.
Scripted mode verifies the controller and tools but does not prove Nemotron or
vLLM tool parsing.

## Scope

This smoke workflow exercises only topology inspection. The diagnostic runtime
adds bounded evidence collection separately; neither workflow permits mutation.
