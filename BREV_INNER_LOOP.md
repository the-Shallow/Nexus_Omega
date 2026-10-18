# Brev: run three real vLLM diagnosis scenarios

This run uses three candidates from `data/issue-candidates.csv`: `VLLM-55530`, `VLLM-59218`, and `VLLM-56943`. Each starts from a pinned vLLM commit, runs a focused CPU reproduction, supplies the observation to the Nexus inner loop, lets Nemotron request bounded evidence, and checks its diagnosis and repair proposal. The run does not edit vLLM source. A proposed source patch ends at `REQUIRES_APPROVAL`.

The cases come from upstream reports [#55530](https://github.com/vllm-project/vllm/issues/55530), [#59218](https://github.com/vllm-project/vllm/issues/59218), and [#56943](https://github.com/vllm-project/vllm/issues/56943).

## Prerequisites

- Python 3.11+ with Nexus installed (`python -m pip install -e .` from this repository).
- A full local clone of [vLLM](https://github.com/vllm-project/vllm), with the three historical revisions available. Do not use a shallow clone.
- A Python environment with vLLM's import and test dependencies, including `openai`. Run the scenarios on the Brev development environment used for vLLM. The probes are CPU-only; the model endpoint may use GPU.
- A reachable Nemotron Chat Completions endpoint that supports native tool calls.

On Brev, from a checkout of Nexus:

```bash
git pull
python -m pip install -e .
git clone https://github.com/vllm-project/vllm.git "$HOME/vllm"
git -C "$HOME/vllm" cat-file -e 'f2e2936f91a794513af74d009286c69e3fb2592b^{commit}'
git -C "$HOME/vllm" cat-file -e '998490c^{commit}'
git -C "$HOME/vllm" cat-file -e 'f94666b^{commit}'
```

If the clone already exists, use its absolute path and skip `git clone`. The three `cat-file` commands must succeed. Set the model connection:

```bash
export NEMOTRON_BASE_URL='http://127.0.0.1:8000/v1'
export NEMOTRON_MODEL='<served-model-id>'
export NEMOTRON_TIMEOUT_SECONDS='120'
# If authentication is required:
# export NEMOTRON_API_KEY='<key>'
```

Run one scenario first:

```bash
python -m scripts.run_issue_scenarios --vllm-repo "$HOME/vllm" --candidate VLLM-59218
```

Then run all three:

```bash
python -m scripts.run_issue_scenarios --vllm-repo "$HOME/vllm"
```

The command exits `0` only if every selected scenario reproduces and its diagnosis passes deterministic checks. It prints a directory under `artifacts/issue-scenarios/<candidate>-<run-id>/` for each run. Inspect `reproduction.json`, `diagnostic-input.json`, `events.jsonl`, `result.json`, and `verification.json`. Probe stdout and stderr are in `probes/probe-reproduce-001/`. The pinned vLLM worktree remains in `workspace/` for inspection; each new run gets a unique directory.

If `reproduction.json` says `reproduced: false`, or if the probe exits nonzero, inspect its stderr first. The runner does not ask Nemotron to diagnose an unreproduced case. Missing Python dependencies, vLLM import errors, or an unavailable historical commit are environment setup problems. If the reproduction succeeds but `verification.json` fails, inspect the cited evidence and proposed files in `result.json`.

## What is being verified

The reproduction is executed against actual vLLM source at the declared revision. The verifier checks that the observation reproduced, the agent cited initial and source evidence, proposed the declared action and expected source location, and stopped in a safe planning state. It does not claim a fix was applied or that a post-fix regression passed.

Nemotron performs the live investigation. NeMo Gym is **not** used for verification in this implementation; the verifier is deterministic Python code in `nexus/evaluation/verification.py`.
