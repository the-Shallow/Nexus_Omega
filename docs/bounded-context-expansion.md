# Bounded context expansion

The agent runtime lets Nemotron decide which missing evidence to request
without giving it arbitrary shell, file-system, or repair access. There is no UI
requirement in this implementation; the append-only JSONL event stream is the
human-readable audit surface.

## Implemented contract

The controller exposes eight read-only tools:

- `get_status`
- `run_canary`
- `get_launch_config`
- `get_request_trace`
- `read_raw_generation`
- `read_logs`
- `search_repository`
- `read_file`

Every call must include `reason`, `hypothesis_id`, and
`expected_information_gain`. The controller logs that metadata and rejects
missing or blank values. Service IDs and canary cases are allow-listed.

The incident harness is injected through the `DiagnosticBackend` protocol in
`nexus/agent/diagnostic_tools.py`. This keeps target-specific Docker, gateway, and
artifact access outside the model-facing controller. The live harness adapter
must implement those six methods; it must not expose hidden verifier canaries.
Repository access is separately injected through `BoundedRepository`, which
contains reads beneath explicit project subdirectories and allows at most 250
lines per file request. Source text is always returned as untrusted data.

## Evidence flow

```text
Nemotron tool call
  -> schema and allow-list validation
  -> context budget check
  -> DiagnosticBackend read
  -> immutable evidence artifact + SHA-256
  -> ev-* record returned to Nemotron
  -> final hypothesis citation validation
```

The controller rejects a final diagnosis that cites an unknown evidence ID. A
`PLAN` decision requires at least one hypothesis and at least one real supporting
evidence record for the leading hypothesis. An evidence-backed `PLAN` may now be
evaluated by the deterministic repair policy described in
`docs/safe-repair-planning.md`; the runtime still does not expose or run mutation
tools.

## Default budgets

- 12 total model/tool steps;
- 15 total tool calls;
- 5 context-expansion rounds;
- 3 evidence requests in one model turn;
- 2 requests for the same tool and operational arguments;
- 200 log lines per request;
- 8 source files per run;
- 250 lines per file request and 1,500 source lines per run;
- 120 seconds wall-clock time.

Rationale text is excluded from the repeated-request key, so rewording a reason
cannot bypass the limit. Identical results are deduplicated in the evidence
ledger and truncation is recorded on the evidence entry.

## Verification

Run the local contract suite:

```bash
python -m unittest discover -s tests -v
```

The scripted acceptance path begins with only the symptom, then requests a
visible canary, its raw generation, and the effective launch configuration. It
ends in `PLAN` only after citing the three controller-issued evidence IDs.

Full live acceptance additionally requires the Nemotron vLLM endpoint and the
target-harness `DiagnosticBackend` adapter. The expected live sequence is:

```text
HTTP 200 + zero parsed tool calls
  -> raw fenced call-shaped generation
  -> Hermes/default-template launch configuration
  -> evidence-backed parser/template mismatch diagnosis
```
