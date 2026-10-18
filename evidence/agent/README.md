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
| Nemotron | **after design changes** (structured build 4, `db9836c`; 08:03–08:23 UTC) | 3/3 (87 s) | 3/3 (34 s) | 3/3 (72 s) | 2/3 (90 s) | **11/12** | 0 |

**Held-out faults** (built after the solvers were frozen; neither was written or tuned against them)

| Solver | Setup | compound-latb-32926a | capacity-b | tools-stripped-a | noop | Total | False VERIFIED |
|---|---|---|---|---|---|---|---|
| Rule baseline | Batch 2 (2026-10-18 03:29–04:01 UTC) | 0/3 (20 s) | 0/3 (56 s) | 0/3 (2 s) | 3/3 (2 s) | **3/12** | 0 |
| Nemotron | Batch 2 round 1 only, **contaminated** (stale metrics; see below) | 0/1 | 0/1 (scored 1/1 by the old referee) | 0/1 (crash) | 0/1 [1] | 0/4 | 1 |
| Nemotron | Batch 2 rerun, before design changes (incident-scoped evidence, stricter referee; 04:21–05:08 UTC) | 0/3 (130 s) | 0/3 (112 s) | 1/3 (19 s) | 1/3 [1] (50 s) | **2/12** | 1 |
| Nemotron | **after design changes** (structured build 4, `db9836c`; 07:32–08:03 UTC) | 2/3 (152 s) | 1/3 (105 s) | 3/3 (92 s) | 3/3 (7 s) | **9/12** | 0 |

**Held-out v2** (written before the design changes, `60bdd15`; two are label swaps of known faults)

| Solver | Setup | noauto-a | vllm-32926-b | kill-a | compound-killb-32926a | Total | False VERIFIED |
|---|---|---|---|---|---|---|---|
| Rule baseline | 2026-10-18 05:06–05:39 UTC | 3/3 (77 s) | 3/3 (78 s) | 3/3 (113 s) | 3/3 (151 s) | **12/12** | 0 |
| Nemotron | before design changes (old free-form agent) | 3/3 (88 s) | 3/3 (89 s) | 1/3 (56 s) | 3/3 (194 s) | **10/12** | 0 |
| Nemotron | **after design changes** (structured build 4, `db9836c`; 06:52–07:32 UTC) | 3/3 (84 s) | 3/3 (91 s) | 3/3 (130 s) | 3/3 (179 s) | **12/12** | 0 |

**BFCL** (200 pinned cases, gorilla `6ea5797`; worker a, only the serving profile changes)

| Serving profile | simple | multiple | parallel | irrelevance | Tool-calling score | Call-shaped text in content |
|---|---|---|---|---|---|---|
| `tools-template` (healthy; the repair) | 46/50 | 45/50 | 33/50 | 40/50 | **0.83** | 0/150 |
| `vllm-32926` (broken: hermes parser) | 0/50 | 0/50 | 0/50 | 50/50 | **0.00** | 118/150 |
| `tools-stripped` (held-out broken: template drops tools) | 0/50 | 0/50 | 0/50 | 50/50 | **0.00** | 0/150 |

Run 2026-10-18 03:18–03:25 UTC with `scripts/bfcl_arms.sh` (records in `../bfcl/`). Tool-calling score = simple + multiple + parallel. Both broken profiles still return HTTP 200 with `/health` 200, and 0 HTTP errors in 600 requests: users lose all tool calling and no alert fires. The one-step repair restores 0.83. This is our own pinned measurement of the effect the paper reports as 0.00 → 0.96 (arXiv 2609.03966); different model and case subset, so the numbers are not directly comparable. Irrelevance at 50/50 on the broken profiles is not a strength: a server that never produces a tool call trivially "declines" every irrelevant request. The last column is what the rule baseline's regex sees: 32926 leaks call-shaped text, the stripped template leaks none (the model answers in prose), which is why the rules can catch one and not the other.

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


### Batch 2: held-out faults ×3

`python -m nexus.eval.episode heldout --solver rules --repeat 3`, then `--solver agent`, on the fixed executor (VERIFIED also needs the route through HAProxy). Each fault passed a live gate check first: tools-stripped through BFCL (0/150 call-shaped responses), capacity-b directly (b p95 4.5 s through HAProxy and 4.5 s direct, a 0.2 s; the healthy profile under the same load gives 0.06 s; `artifacts/gate-capacity.log` on Brev). Rule records: `../heldout/rules-episodes.json`.

**Rule baseline: 3/12, 0 false VERIFIED.** Identical in all three rounds:

| Fault | Result | What the rules did |
|---|---|---|
| compound-latb-32926a | ❌ REQUIRES_APPROVAL | Rule order checks links first: drained b, then in round 2 tried to patch a. The executor refused ("no other worker is serving; this action would cause an outage"), so a stayed broken and users were left with no healthy worker |
| capacity-b | ❌ ABSTAIN | b slow through HAProxy *and* direct, so the link rule (route slow, direct fast) does not match; the canary eventually passes, so no other rule fires |
| tools-stripped-a | ❌ ABSTAIN | HTTP 200, 0 tool calls, but prose instead of call-shaped JSON, so the parser rule does not match |
| noop | ✅ ABSTAIN | Nothing matched, nothing done |

The rules fail safe (no false claims, no harmful action that the executor let through), but they only fix what their author anticipated, and their fixed order is wrong when two faults interact.

**Nemotron, round 1 (stopped after 4 of 12 episodes).** Records `../heldout/agent-round1-contaminated.json`, trails in `runs/`.

| Fault | Runs | Logged | What happened |
|---|---|---|---|
| compound-latb-32926a | `run-bffd2577`, `run-efcd7fff` | ❌ REQUIRES_APPROVAL | Round 1 restarted b; round 2 applied the healthy profile to **b**, though its own summary said *a* had the hermes parser. The new executor route check caught both ("passes on its own port but not through HAProxy"), so no false claim, but a was never fixed |
| capacity-b | `run-914bc452` | ✅ by the old referee, ❌ in truth | Drained b, calling it a network-proxy fault. The old referee's "root fixed" was only the hidden canary, which a one-sequence worker still passes (correctly, slowly); draining hid the fault without fixing it |
| tools-stripped-a | `run-1615f8c8` | ❌ ABSTAIN (crash) | ContractError: "PLAN requires evidence for the leading hypothesis" |
| noop | `run-036cb2f3` | ❌ false VERIFIED | Summary: "Both targets are healthy … No abnormalities detected", then proposed restart-worker on a anyway |

**Nemotron rerun ×3 (clean evidence, stricter referee): 2/12, 1 false VERIFIED.** This is the held-out v1 "before" for the design changes. Records `../heldout/agent-v1-before.json`, trails in `runs/`.

| Fault | Rounds (action:target per solver round) | Pattern |
|---|---|---|
| compound-latb-32926a | `apply:b → apply:a`, `apply:b → apply:b`, `apply:b → apply:a` | Always repaired **b** first (wrong worker; its config was the healthy one), which the executor's route check then drained; by round 2 a could no longer be repaired without an outage |
| capacity-b | drain b, restart b, ABSTAIN | Never found the concurrency cap; called the configurations identical |
| tools-stripped-a | crash, crash, ✅ apply:a VERIFIED | Two "PLAN requires evidence for the leading hypothesis" crashes, then a clean fix |
| noop | restart b (false VERIFIED), ✅ ABSTAIN, drain b | Acted on a healthy fleet in 2 of 3 runs |

**Why the batch was stopped: two harness faults, not agent faults.**
1. *Stale evidence across episodes.* During the compound fault the agent queried a 10-minute metric window and got b's TTFT p95 4.8 s and queue 4. A link toxic cannot produce either (it delays the proxy, not vLLM). They came from the previous episode, the rules' capacity-b run. The agent partly reasoned from another incident's data, while the rules, which never read Prometheus, were unaffected. Fix: the episode runner marks the incident start after each reset, and the environment API clamps metric windows and log `since` to it, saying so in a note (`nexus/harness/incident.py`).
2. *Weak "fixed" check.* Now a worker counts as fixed only if it is back in rotation, within the SLO through HAProxy, and passing the hidden canary. Rescoring the rule baseline with it changes nothing (its only successes were noop).

Neither fix changes the agent, its prompts, or the rules, so the faults remain held out. Rounds 2–3 were discarded unrun; the agent is rerun ×3 from the start.

### Structured workflow: four builds, each fixing one observed failure

After held-out v1, the end of the run was redesigned following `docs/research/agent-workflow-findings.md`: code runs the workflow and the model fills in judgments (`nexus/agent/structured.py`). Each build was tried live; the run was stopped as soon as a failure showed a flaw in the design, the flaw was fixed with a general rule, and the next build ran. Every episode is kept (`../heldout/structured-dev-builds.json`, trails in `runs/`).

| Build | Commit | What it added | What it showed live | Episodes |
|---|---|---|---|---|
| 1 | `df016e6` + `757dff1` | Assess every resource → choose from a code-built menu of valid moves (with capacity-ordering notes) → code builds the decision; neutral manifest; `config-diff` and `path-compare` probes in the opening snapshot | noop ✅ in 8.5 s ("no fault found"). compound-v1 ❌: config-diff said a and b *differ*, not which is wrong; the agent blamed b, the correctly configured one | `run-2292fa31`; `run-838cf85b`, `run-88a6b87a` |
| 2 | `78a9184` | config-diff compares each worker with the **reviewed** configuration | 3/6 on v2 before stopping. Findings correct but labels contradicted them: "HTTP 400 … diverging from the reviewed configuration … directly explains the canary failure", labelled **healthy / none** | `run-8e3c1459` … `run-a5592950` |
| 3 | `a16a1b9` | Probes flag abnormal resources; code rejects a "healthy" label against flags, naming the evidence | The check fired as intended, but the retry labelled the worker **degraded / unknown** while its finding said "this misconfiguration is the identified cause" | `run-3742585b`, `run-47fb1cdd` |
| 4 | `db9836c` | Each flagged or non-healthy resource is **labelled again from its own finding in a short, separate context** | **v2: 12/12, 0 false VERIFIED** | see matrix |

The pattern behind builds 2–4: Lightning's written findings were consistently right; the labels it chose at the end of a long structured answer were not. Moving the labelling into a short, focused context fixed it. Held-out caveat: v2 was frozen before any of this (`60bdd15`), but builds 2–3 ran on half of it, so build 4's v2 score is not fully blind; each fix is a general rule (compare with the reviewed config, hold labels to flagged evidence, label in a short context), none mentions a specific fault.

**Build 4 on held-out v1: 9/12, 0 false VERIFIED** (old agent 2/12, rules 3/12). Records `../heldout/agent-v1-after.json`.

| Fault | Result | Notes |
|---|---|---|
| compound-latb-32926a | 2/3 | Rounds 1 and 3 repaired a, then drained b: the right order, which neither the rules nor the old agent ever found. Round 2 drained b first despite the menu note "do this after repairing target-a", then a could not be repaired |
| capacity-b | 1/3 | Round 3 applied the reviewed profile to b (VERIFIED), the first correct fix of this fault by any solver. In rounds 1–2 the draft assessment was right ("misconfigured … max_num_seqs 1 vs default … bottleneck on the worker itself"), but build 4's short relabel call changed it to *overloaded*, for which only a drain is offered |
| tools-stripped-a | 3/3 | Old agent: 1/3 with two crashes |
| noop | 3/3 | "No fault found" in 7–13 s; the old agent acted on a healthy fleet in 2 of 3 runs |

Next fix (not run: it would mean rerunning v1 and v2 after the deadline for this batch): relabel only when the draft contradicts the evidence (healthy despite flags, or class none/unknown), never override a specific valid fault class.

**Build 4 on the known faults: 11/12, 0 false VERIFIED** (before 7/12 with 3). Records `known-after.json`. Link faults were drained in 6/6 (before: restarted in 3/6). The miss, kill-b round 1, decided in 9 s without checking process state: the opening snapshot does not include container state, so it saw "100% errors on both paths, no config difference", drafted failed/unknown, and the relabel call turned that into network_path (contradicting that class's own definition), so it drained. Next fix: add process state to the opening snapshot, and relabel only contradictory drafts.

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
- BFCL hidden canaries (add held-out BFCL cases to `runtime/canaries/hidden.jsonl` after Batch 2).
- Large reference model on the same episodes (needs an endpoint).
- Record `run_id` in each episode, so episodes and trails link directly rather than by time (added to `nexus.eval.episode` with this log).
