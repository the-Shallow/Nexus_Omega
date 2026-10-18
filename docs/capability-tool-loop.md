# Capability tool-loop smoke test

This is the smallest end-to-end check of the model endpoint. It exposes one
generic `describe_environment` capability and verifies that the model selects
it through the native vLLM tool-call protocol.

Scripted mode makes no model call:

```bash
python -m scripts.capability_smoke_test --mode scripted --runs 3
```

Live mode uses `NEMOTRON_BASE_URL`, `NEMOTRON_MODEL`, and the optional
`NEMOTRON_API_KEY`:

```bash
python -m scripts.capability_smoke_test --mode live --runs 3
```

This validates model-side tool calling only. A full diagnostic run also needs a
target environment implementing the HTTP capability contract in `E1.md`.
