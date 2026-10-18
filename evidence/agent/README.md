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

## Results matrix

Each cell is successes/episodes, with false VERIFIED in brackets. Success is judged by the independent referee (`nexus.eval.episode`), never by the solver. Median solve time includes the executor's restart and hidden canary (~75 s whenever a worker is relaunched).

**Known faults** (the rules were written for these; the agent was tuned on VLLM-32926)

| Solver | Setup | vllm-32926 | net-latency-b | net-blackhole-b | kill-b | Total | False VERIFIED |
|---|---|---|---|---|---|---|---|
| Rule baseline | — | 3/3 (74 s) | 3/3 (18 s) | 3/3 (47 s) | 3/3 (75 s) | **12/12** | 0 |
| Nemotron | Batch 1, before fixes (2026-10-18 02:48–03:10 UTC) | 3/3 (93 s) | 1/3 [2] (97 s) | 2/3 [1] (38 s) | 1/3 (14 s) | **7/12** | **3** |

**Held-out faults** (built after the solvers were frozen; neither was written or tuned against them)

| Solver | Setup | compound-latb-32926a | capacity-b | tools-stripped-a | noop | Total | False VERIFIED |
|---|---|---|---|---|---|---|---|
| Rule baseline | — | not run yet | | | | | |
| Nemotron | — | not run yet | | | | | |

**BFCL** (200 pinned cases, gorilla `6ea5797`; worker a, only the serving profile changes)

| Serving profile | simple | multiple | parallel | irrelevance | Tool-calling score |
|---|---|---|---|---|---|
| not run yet | | | | | |

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

### Batch 1: all four known faults ×3 (before fixes)

`python -m nexus.eval.episode all --solver agent --repeat 3` on merge `18f8d9a`. Started 02:48 UTC; the summary line read `7/12 succeeded, 3 false VERIFIED`. Records `episodes/2026-10-18T0250*`–`T0310*`, trails in `runs/`.

| Round | Fault | Run | Result | Action | What happened |
|---|---|---|---|---|---|
| 1 | vllm-32926 | `run-7ed83f56` | ✅ VERIFIED | apply-serving-profile a | Same diagnosis as the earlier 3/3 |
| 1 | net-latency-b | `run-d7241613` | ✅ REQUIRES_APPROVAL | drain-worker b | "b p95 1.665 s, a 0.035 s, identical configuration" → drained, link left for a human |
| 1 | net-blackhole-b | `run-bf811f8b` | ✅ REQUIRES_APPROVAL | drain-worker b | Same reasoning, 100% errors |
| 1 | kill-b | `run-4d48618e` | ❌ ABSTAIN (crash) | — | Asked for logs `since` an ISO timestamp; the environment API accepts only `30s`/`10m`/`2h`, returned 400, and one tool error aborts the run |
| 2 | vllm-32926 | `run-440dff8b` | ✅ VERIFIED | apply-serving-profile a | |
| 2 | net-latency-b | `run-685d47a5` | ❌ **false VERIFIED** | restart-worker b | Correct symptom ("b high error rate and p95, a healthy"), wrong action. The executor's hidden canary hits b's port directly, which bypasses the impaired link, so the restart "verified" while users through HAProxy still saw p95 1.7 s |
| 2 | net-blackhole-b | `run-85fd4883` | ❌ **false VERIFIED** | restart-worker b | Same: direct check passed, the route still had 100% errors at 5 s |
| 2 | kill-b | `run-c51cdb4e` | ❌ ABSTAIN (crash) | — | Called `run_probe` without `probe_id`/`inputs`; the malformed call aborts the run |
| 3 | vllm-32926 | `run-96915174` | ✅ VERIFIED | apply-serving-profile a | |
| 3 | net-latency-b | `run-1f9ed99f` | ❌ **false VERIFIED** | restart-worker b | As in round 2 |
| 3 | net-blackhole-b | `run-3e3ddf5c` | ✅ REQUIRES_APPROVAL | drain-worker b | |
| 3 | kill-b | `run-bb656ff4` | ✅ VERIFIED | restart-worker b | "target-b container has exited … restart the target-b worker" |

**What Batch 1 shows.**
- *The referee works; the executor's own check did not.* All three false VERIFIED claims came from the executor's post-change check, which tests the repaired worker on its own port. A link fault lives between HAProxy and the worker, so that check cannot see it. The independent referee, which probes the users' path, caught all three. The fix belongs to the executor (E2): it must also check the route through HAProxy before it says VERIFIED. Until then, a wrong action on a link fault can be reported as fixed.
- *Diagnosis was right far more often than the action.* On the link faults, every run named the symptom correctly ("b slow or failing, a healthy, identical configuration"). In 3 of 6 it chose restart instead of drain. At temperature 0, the same fault produced different actions across rounds, because each round's live measurements differ.
- *kill-b failed twice on one malformed or rejected tool call each.* The diagnosis was trivial ("container has exited") when the run survived. One bad tool call ending the whole run is the same weakness as attempt #1 above.
- VLLM-32926 stays at 3/3, which makes 6/6 across both sessions.


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

- Fixes from Batch 1, each rerun and logged as an "after fix" row: the executor also verifies the route through HAProxy (E2); the environment API accepts timestamps for log `since` (E2); a malformed tool call goes back to the model as an error instead of aborting the run (E1's controller, needs Khush).
- Held-out faults (built in `0d6f318`): compound-latb-32926a, capacity-b, tools-stripped-a, noop, for both solvers.
- BFCL per serving profile (`nexus.verifier.bfcl`, built in `c7f0caa`), then BFCL hidden canaries.
- Large reference model on the same episodes (needs an endpoint).
- Record `run_id` in each episode, so episodes and trails link directly rather than by time (added to `nexus.eval.episode` with this log).
