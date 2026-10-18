# Agent evaluation log: Nemotron on the live fleet

This is the record of putting Nemotron 3.5 Lightning in charge of the live Brev fleet, kept for the report and the evaluation. It includes the failed attempts, because how a small model fails, and what made it reliable, is part of the result.

## Setup

| | |
|---|---|
| Agent model | `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` (≈30B total, ≈3B active per token), vLLM v0.27.1, 35% of one H100, `--max-num-seqs 64`, temperature 0 |
| Agent runtime | E1's manifest-driven controller (`nexus/agent/controller.py`, `nexus/app.py`) plus the fixes listed below |
| Environment | `apps/environment` (E1.md §3 API) over two Qwen2.5-Coder-7B workers behind HAProxy |
| Trigger | A monitoring snapshot taken through the environment API: route probe through HAProxy, plus the visible tool-call canary on each worker. These are the same signals the rule baseline starts from. No hint about the fault. |
| Actions | Declared in the manifest (`apply-serving-profile`, `drain-worker`, `restart-worker` automatic; `undrain-worker` needs approval). Policy and precheck in E1's runtime; applied by `nexus.harness.executor` (drain → change → hidden canary → undrain or roll back). |
| Referee | `nexus.eval.episode`, independent of the agent: users served (route probe + hidden canary through HAProxy) and root cause fixed (hidden canary on the faulty worker). The agent never declares its own success. |
| Fairness | Worker profile names are hidden from the agent (from commit `24bf2e3`), because the broken profile is literally named `qwen25-coder-7b.vllm-32926`. |

## Results so far

### VLLM-32926 (silent tool-call fault on `target-a`)

| Solver | Episodes | Success | False VERIFIED | Median time | Action |
|---|---|---|---|---|---|
| Rule baseline | 3 | 3 | 0 | 74.4 s | patch to healthy profile |
| **Nemotron (final setup)** | 3 | **3** | **0** | 89.3 s | `apply-serving-profile qwen25-coder-7b.tools-template` on `target-a` |

Of the agent's ~89 s, about 75 s is the executor's restart and hidden canary, which is the same for both solvers. The rest is about 14 s of diagnosis.

What Nemotron did in each final run (all three were identical):
1. `describe_environment`
2. `get_configuration` on `target-a`, then `target-b`
3. `get_resource_state` on both
4. Proposed `apply-serving-profile` on `target-a`, citing the two canary results and both configurations: `ev-002`, `ev-003`, `ev-005`, `ev-006`

7 model steps, 5 context rounds. Its summary in one run: *"target-a uses incompatible tool_call_parser 'hermes' with 'model default' chat_template, producing 0 structured tool calls. target-b uses correct 'qwen2_5_coder' parser…"*

### Other faults

Not yet run with the agent: link latency on `b`, link blackhole on `b`, worker `b` killed. The rule baseline is 12/12 on all four (`../baseline/rules-episodes.json`).

## How it got there: every attempt

All on VLLM-32926. Episodes in `episodes/`, matching trails in `runs/` (matched by start time).

| # | Time (UTC) | Run | Result | What went wrong | Fix |
|---|---|---|---|---|---|
| 1 | 01:23 | `run-2ee04878` | ABSTAIN (crash) | Asked for state fields the manifest can't declare (`container_state`, `profile_label`); the API returned 400, and one tool error aborts the run | API answers known fields and lists the unavailable ones (`6821fd8`) |
| 2 | 01:26 | `run-29e33797` | ABSTAIN (crash) | Gathered the right evidence, then *called* `apply_action` as a tool; that counted as a 6th context round (budget 5) | Redirect a called repair into a PLAN; budget 8 rounds (`b332315`) |
| 3 | 01:33 | `run-fb3983f1` | ABSTAIN (crash) | Cited evidence as `"ev-002: target-a has …"` | Reduce a leading `ev-N` citation to the ID (`b332315`) |
| 4 | 01:38 | `run-9c936df3` | **VERIFIED** | Correct, but it read the worker's profile name, which names the fault | Hide profile names from the agent (`24bf2e3`) |
| 5 | 01:57 | `run-7a4d7e64` | ABSTAIN (crash) | Without the label, kept querying metrics until the 8-round budget ran out | At the budget, ask for the final decision instead of crashing (`e60bf0f`) |
| 6 | 02:00 | `run-6e17c1c7` | ABSTAIN (crash) | Correct repair proposed, but cited prose as evidence | Final schema limits citations to issued evidence IDs; one validated retry (`e60bf0f`) |
| 7 | 02:03 | `run-447c63a9` | ABSTAIN (crash) | Correct repair proposed, but cited the action name as evidence | Same (`e60bf0f`) |
| 8–10 | 02:07–02:13 | `run-8bf1324b`, `run-4cd17665`, `run-a12ed62b` | **VERIFIED ×3** | — | — |

**What this shows.** Ten episodes: 4 VERIFIED, 6 failed. Nemotron's *diagnosis* was right early on: in 4 of the 6 failed runs (#2, #3, #6, #7) it had already identified the parser/template mismatch and the correct repair. What failed was *finishing in the exact contract*: calling the repair instead of writing it, citing prose instead of IDs, and not knowing when to stop. These are typical small-model habits. They were fixed by having the runtime enforce structure (constrained decoding with run-specific schemas, a single guided retry, a redirect, a hard stop that asks for a conclusion), not by making the prompt longer. Throughout, nothing ran without passing the policy check, the precheck and the hidden canary, and there were zero false VERIFIED claims, including in the failed runs.

## Runtime changes made during this evaluation

Each change has a detailed commit message addressed to E1 for review:

| Commit | Change |
|---|---|
| `3556f81` | A malformed final answer gets one retry with the decision schema enforced (vLLM `response_format`); the retry sends no tools, caps output at 1,024 tokens and turns thinking off (without that, one in three retries ran away to the timeout) |
| `b332315` | A repair *called* as a tool is redirected into a PLAN (not executed, no context round spent); string `parameters` parsed; `ev-N: …` citations reduced to the ID; context budget 5 → 8 rounds, with the run budget raised to match |
| `e60bf0f` | The final schema limits citations to this run's evidence IDs and the state to PLAN/ABSTAIN; semantic rejections get the guided retry; plan evidence must support its hypothesis; running out of rounds asks for a conclusion |
| `24bf2e3` | Worker profile names hidden from the agent (fairness) |
| `6821fd8` | Environment API answers unknown state/config names instead of failing |

## Still to do

- Agent on link latency, link blackhole and worker crash (×3 each), against the rules' 12/12.
- Held-out faults the rule author didn't anticipate (compound faults, overload vs link, a 32926 variant, a no-op), for both solvers.
- BFCL hidden canaries.
- Large reference model on the same episodes (needs an endpoint).
- Record `run_id` in each episode, so episodes and trails link directly rather than by time (added to `nexus.eval.episode` with this log).
