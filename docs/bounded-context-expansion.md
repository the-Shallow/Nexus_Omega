# Bounded context expansion

The inner loop begins with a structured `DiagnosticInput`, not an assumed root
cause. It contains a trigger ID, summary, observation time, affected resource
IDs, optional human context and correlation IDs, and bounded initial
observations. Domain-specific operations do not live in the controller.

Initial observations are validated against declared resources and written to
the evidence ledger before the first model call. Nemotron receives their
controller-issued `ev-*` IDs and can cite them immediately. Logs and other
untrusted inputs carry an explicit instruction boundary.

`EnvironmentManifest` declares resources, probes, configuration keys, metrics,
artifact sections, verifiers, and repair actions. `EnvironmentTools` turns that
declaration into generic model-facing tools:

- `describe_environment` and `list_resources`;
- `get_resource_state` and `get_configuration`;
- `query_logs` and `query_metrics`;
- `run_probe` and `read_artifact`;
- optional bounded `search_repository` and `read_file`.

Every request includes `reason`, `hypothesis_id`, and
`expected_information_gain`. Schema validation, manifest scoping, repetition
limits, and run budgets happen before the provider call.

```text
structured trigger + initial observations
  -> immutable initial ev-* records
  -> model hypothesis + typed evidence request
  -> schema / manifest / budget validation
  -> generic EnvironmentProvider read
  -> immutable evidence artifact + SHA-256
  -> controller-issued ev-* ID
  -> cited diagnosis or abstention
```

Logs, artifacts, and repository content are marked untrusted. A final diagnosis
cannot cite an unknown evidence ID, and a `PLAN` needs real supporting evidence.

The default limits are 32 total operations, 16 model steps, 20 tool calls, eight expansion
rounds, three calls in one turn, two repetitions of the same operational
request, 200 log lines, eight source files, 250 lines per source read, 1,500
source lines total, and 120 seconds wall-clock time.
