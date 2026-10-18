# Findings: designing tool-calling workflows that a ~30B model executes reliably

Answer to `agent-workflow-research-prompt.md`. Written 2026-10-18. No code was changed.

## How to read this

The short version: your model is usually right about *what is wrong* and unreliable about *what to do about it*. The research agrees with that pattern. Small and mid-size models do much better when code makes the decisions that can be made by rule, and the model fills a small number of clearly bounded slots. Most of what follows comes back to one idea: move every choice that you can check out of the model's free text and into a menu, a table, or a controller rule.

**How strong is the evidence?** Very little published work tests a 3B-active MoE model on an ops agent. Most results below come from GPT-3.5/GPT-4-class models, from 7–9B open models, or from frontier models. Each guideline says which. Where I could not find support for a claim, I say so and mark it as engineering judgement.

**About the model.** I could not find a public model card for "Nemotron 3.5 Lightning". The closest verified card is [NVIDIA-Nemotron-3-Nano-30B-A3B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16): 30B total and 3.5B active parameters, BFCL v4 53.8, and τ²-bench average 49.0. It has a reasoning mode that is on by default and is switched with `enable_thinking`. NVIDIA recommends **temperature 0.6 / top_p 0.95 for tool calling**, not greedy decoding. If Lightning is a variant of this model, temperature 0 is outside the vendor's tested setting. That does not make it wrong, but it is one more reason to measure run-to-run consistency directly (Guideline 12).

---

## Part 1 — Ranked design guidelines

Ranked by how much they should help *your* failures for the effort involved. The "Fixes" field refers to the observed failures 1–6.

### 1. Let code drive the workflow; let the model fill in the steps

**Rule:** Use a fixed sequence of phases (triage, then targeted checks chosen from the manifest, then per-entity assessment, then decision) instead of an open-ended "think, call a tool, repeat" loop, and give the model a choice only inside each phase.

**Why, in plain terms:** An open loop asks the model to plan, gather evidence, judge, and decide all at once, and every extra choice is another chance to wander. A fixed sequence of phases removes the planning burden, so the model only has to do the step in front of it. Anthropic calls this a **workflow** (code-defined path), as opposed to an **agent** (model-directed loop), and recommends starting with the simplest one that works.

**Evidence:**
- *Agentless* ([Xia et al., 2024, arXiv 2407.01489](https://arxiv.org/abs/2407.01489)): a fixed localize → repair → validate pipeline with GPT-4o solved 32.0% of SWE-bench Lite at $0.70 per issue. That beat several agent frameworks on the same model, for example SWE-agent + GPT-4o at $2.53. The authors name the agents' failure modes: confusion across a large action space, runs of 30–40 turns, and failing to filter out misleading feedback. *Frontier model.*
- *Flow-of-Action* ([WWW Companion 2025, arXiv 2502.08224](https://arxiv.org/abs/2502.08224)): root-cause analysis for microservices, guided by standard operating procedures. With **GPT-3.5-Turbo**, ReAct averaged 19.2% and the SOP-guided system 54.1%. Removing the SOP flow alone dropped it to 27.5%. With GPT-4-Turbo the figures were 35.5% vs 64.0%. **This is the closest published result to your setting: an ops task and a weak model.**
- *Blueprint First, Model Second* ([Qiu et al., 2025, arXiv 2508.02721](https://arxiv.org/abs/2508.02721)): a deterministic workflow engine that calls the LLM only at bounded nodes. On TravelPlanner, the final pass rate went from 10.4% (ReAct) to 35.6% with Claude Sonnet 4. It was also higher on ScienceWorld (43.3 → 56.7). *Frontier models only.*
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (vendor guidance): describes the prompt-chaining, routing, and workflow-vs-agent tradeoff.

**Keeping it general:** The controller can stay neutral about the environment if the *phases* are fixed and the *contents* come from the manifest. Triage reads the snapshot. "Targeted checks" are the manifest's probes for each resource that is not healthy. "Assessment" iterates over the manifest's resource list. "Decision" picks from the manifest's actions.

**Expected effect:** 2–3× higher task accuracy for weak models on structured diagnosis tasks (Flow-of-Action, GPT-3.5). No 3B-active measurement exists.

**Fixes:** 3, 5, 7 (and it underpins 1 and 2).

### 2. Make the final action a closed menu of (action, target) pairs, including "do nothing"

**Rule:** The decision schema should not contain a free-text `tool` string and an open `arguments` object. It should contain one `enum` field whose values are the concrete moves the manifest allows right now (for example `drain-worker:target-b`, `apply-serving-profile:target-a`), plus an explicit `NO_ACTION`.

**Why:** If the action and the target are separate free fields, the model can get each one right in its head and still type the wrong pair. With a single menu item, the action and the target are chosen together. Including a real "nothing is wrong" option matters because models are trained to *do* something with tools. A benchmark category exists precisely because models call tools when none applies. BFCL calls this **irrelevance (or relevance) detection**. Anthropic's term for designing arguments so mistakes are hard to make is **poka-yoke**.

**Evidence:**
- BFCL ([Patil et al., ICML 2025, PMLR 267](https://proceedings.mlr.press/v267/patil25a.html)): it scores abstention as its own category, because good single-turn calling does not imply knowing when *not* to call. The live leaderboard is [here](https://gorilla.cs.berkeley.edu/leaderboard.html).
- SWE-agent ([Yang et al., 2024, arXiv 2405.15793](https://arxiv.org/abs/2405.15793)): an edit command with a guardrail that rejects syntactically broken edits. With GPT-4 Turbo on SWE-bench Lite, removing the guardrail cost 3.0 points (18.0 → 15.0), and removing the edit command altogether cost 7.7. Interface constraints pay off.
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (the "poka-yoke your tools" section) and [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (vendor guidance).

**Expected effect:** Wrong-target errors in which the target exists but was mis-paired should essentially disappear, because the schema makes them unrepresentable. I found no paper that measured this for a 3B-active model.

**Fixes:** 1, 2, 6.

### 3. Diagnose first in an unconstrained (or lightly constrained) step, then decide under a strict schema

**Rule:** Do not put the model under the full decision grammar while it is still reasoning. Let it reason freely, either in reasoning mode or in a free-text "diagnosis" call. Then make a second call, or a final constrained segment, whose schema forces only the decision fields. Inside any JSON, put the reasoning fields *before* the answer fields.

**Why:** A model works out an answer as it writes. If the format forces it to write the answer first, it has to commit before it has thought. Tight grammars from the first token remove the model's room to work things out. This is the "constrain too early" cost: researchers measured drops in **reasoning under format restrictions**, and they trace much of the drop to **field order** (answer before reason).

**Evidence:**
- *Let Me Speak Freely?* ([Tam et al., 2024, arXiv 2408.02442](https://arxiv.org/abs/2408.02442)) tested 8–9B open models and GPT-3.5-class models. Under JSON mode, accuracy fell sharply. For example, GPT-3.5's Last Letter score fell from 56.7 to 25.2. A two-step "answer in natural language, then convert to the format" approach recovered nearly all of it. In JSON mode, 100% of GPT-3.5's outputs put `answer` before `reason`.
- The rebuttal, *Say What You Mean* ([dottxt, 2024](https://blog.dottxt.ai/say-what-you-mean.html)), argues the original study was confounded by its prompts. With Llama-3-8B, a schema that included a bounded reasoning field, and a prompt that showed the schema, structured output **matched or beat** unstructured output (GSM8K 0.77 vs 0.78; Last Letter 0.73 vs 0.77). **Both sides agree: give the model room to reason before the answer, inside or outside the JSON.**
- CRANE ([Banerjee et al., ICML 2025, arXiv 2502.09061](https://arxiv.org/abs/2502.09061)) gives a theoretical argument that answer-only grammars reduce reasoning. Adding reasoning rules to the grammar gained up to 10 points over both constrained and unconstrained decoding on open-source models.
- vLLM ([structured outputs docs](https://docs.vllm.ai/en/latest/features/structured_outputs.html)): with `--reasoning-parser`, the schema applies to `content`. The reasoning text is returned separately in `message.reasoning`, and constraining it requires `enable_in_reasoning`. So on this stack you can leave reasoning on and still constrain the final JSON.
- *Small LLMs Are Weak Tool Learners* ([Shen et al., 2024, arXiv 2401.07324](https://arxiv.org/abs/2401.07324)) splits tool use across planner, caller, and summarizer roles and reports that this beats a single small model. Note that it is *fine-tuned*, not prompted, so it is only indirect support.

**Expected effect:** On reasoning benchmarks, 0 to over 30 points depending on how badly the original format choked reasoning. Your failures look "last-mile" (Failure 7), which fits this pattern.

**Fixes:** 1, 2, 3.

### 4. Make the model fill one row per resource before it may choose an action

**Rule:** Before any action, the decision must contain an `assessments` array with exactly one entry per manifest resource. Each entry has a `status` (enum: healthy / degraded / faulty / unknown), a `fault_class` (enum from the manifest), and `evidence` (enum of issued evidence IDs). Code then checks that the action agrees with the table.

**Why:** Your model writes "a is misconfigured" and then targets b, because nothing ties the sentence to the field. A per-entity table turns the diagnosis into data that code can compare with the action. This is a **differential diagnosis** made machine-checkable.

**Evidence:** I found **no paper that directly tests per-entity assessment tables on small models**, so this is engineering judgement built from the following:
- Flow-of-Action's JudgeAgent and observation agent: removing them cost 19–20 points with GPT-3.5 (Guideline 1 source). Separate structured judgement steps helped.
- Cloud-OpsBench ([Wang et al., 2026, arXiv 2603.00468](https://arxiv.org/abs/2603.00468)): across ten agents, the best joint RCA accuracy was 0.76/0.68, but "evidence closure" was only 0.38/0.15. Final answers are often right without being tied to evidence, and making that tie explicit is exactly what the table does.
- Agentless (Guideline 1) is itself a fixed "localize first" step before repair.

**Expected effect:** Not measured. The main benefit is that it makes Failures 1 and 2 *detectable by code* (Guideline 5), not that the model reasons better.

**Fixes:** 1, 2, 4.

### 5. Check consistency in code, and send back a specific error; never ask the model to "double-check itself"

**Rule:** After the decision, run deterministic checks and feed back a precise message on failure, at most once or twice. For example: "all resources healthy → state must be ABSTAIN"; "the action's target must have status=faulty"; "the action must be allowed for that fault_class". If it still fails, ABSTAIN/escalate rather than abort.

**Why:** Models are poor at noticing their own mistakes when nobody tells them what is wrong, but good at fixing a mistake someone points to. The literature distinguishes **intrinsic self-correction** (doesn't work) from **correction with external feedback** (does).

**Evidence:**
- *LLMs Cannot Self-Correct Reasoning Yet* ([Huang et al., ICLR 2024, arXiv 2310.01798](https://arxiv.org/abs/2310.01798)): without external feedback, self-correction does not help and sometimes hurts.
- CRITIC ([Gou et al., ICLR 2024, arXiv 2305.11738](https://arxiv.org/abs/2305.11738)): when a tool supplies the feedback, revisions consistently improve.
- Anthropic, [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents): "prompt-engineer your error responses" so they communicate specific, actionable fixes.
- On retry count: **I found no published study of how many format retries pay off for small models.** Engineering judgement: one targeted retry captures most of the value. A second retry with the *same* message rarely changes a temperature-0 output, because the input is nearly identical.

**Fixes:** 1, 2, 6.

### 6. Put safety rules in action preconditions that code enforces and reports, not in prose the model must remember

**Rule:** For each menu item, the controller computes whether the executor would accept it, and whether it would block any *other* pending repair. It shows this next to the option, for example `drain-worker:target-b — BLOCKS later repair of target-a (would drain last serving replica)`, and removes infeasible options from the enum.

**Why:** "Never remove the last healthy replica" is a rule about the *combination* of actions and state. A small model reading a rule in a long prompt will apply it some of the time. The executor already knows the answer, so ask it before the model chooses, not after. Kubernetes does the same thing with a **PodDisruptionBudget**: the eviction API refuses drains that would violate the budget. Doing this for LLM agents is called **runtime enforcement**.

**Evidence:**
- τ-bench ([Yao et al., 2024, arXiv 2406.12045](https://arxiv.org/abs/2406.12045)): with gpt-4o, removing the domain policy from the prompt barely changed retail results (61.2 → 56.8) but collapsed airline results (33.2 → 10.8). The authors read this as the model following complex rules only sometimes. 25% of failures were "wrong decision-making" about domain rules. *Frontier model*; a 3B-active model should be no better at this.
- AgentSpec ([Wang et al., ICSE 2026, arXiv 2503.18666](https://arxiv.org/abs/2503.18666)): rules enforced at runtime prevented unsafe executions in over 90% of code-agent cases with millisecond overhead.
- Kubernetes [disruptions / PodDisruptionBudget docs](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/).
- For multi-fault ordering specifically: **I found no LLM paper evaluating dependency-graph planning for repair ordering.** Engineering judgement: with two workers and three actions, the controller can enumerate every order and keep only the feasible ones. That is cheaper and more reliable than asking the model to plan.

**Fixes:** 5 (and helps 3).

### 7. Build tools that return what differs, not everything that was asked for

**Rule:** Add composite, contrastive tools: a `compare_config` that returns only the keys that differ between workers, and a `compare_paths` that returns direct vs through-proxy latency for each worker side by side. Keep the raw tools, but steer the model to the diff tools first.

**Why:** Your model called two configs "identical" without fetching the one key that differed (Failure 4). A small model scanning two long dumps will miss a one-line difference. A tool that hands back only the difference makes the decisive fact impossible to miss. Anthropic's term is **high-signal tool responses**. SWE-agent's term is **summarized search**.

**Evidence:**
- SWE-agent ablation (GPT-4 Turbo, SWE-bench Lite): the summarized search tool scored 18.0%, iterative result-by-result search 12.0%, and no search tool 15.7%. A 100-line file window beat both a 30-line window (14.3) and the full file (12.7). Showing *less but better* output helped. *Frontier-era model.*
- Anthropic, [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents): consolidate multi-step operations into one tool, return high-signal context, and limit response size.
- *Less is More* ([Paramanayakam et al., DATE 2025, arXiv 2411.15399](https://arxiv.org/abs/2411.15399)): presenting fewer tools to edge-size models improved success and cut execution time by up to 70%. The abstract gives no accuracy figures.
- I found **no paper specifically on contrastive probes** (direct vs proxied). Treat the design as engineering judgement in line with the evidence above.

**Fixes:** 4 (and 3, because a link fault shows up only on the proxied path).

### 8. Describe the environment with neutral facts, not suspicions

**Rule:** The manifest should say what *is* ("target-b's traffic passes through proxy P; probe `path_latency` measures both legs"), never what *might go wrong* ("can be impaired"). Put fault possibilities in the fault-class enum, which applies equally to all resources.

**Why:** A sentence that hints at a cause works like a leading question: the model picks the cause it was primed with. LLMs are measurably pulled by irrelevant or suggestive text in the prompt. This is **distraction by irrelevant context**, and the closely related effect is **anchoring**.

**Evidence:**
- [Shi et al., ICML 2023, arXiv 2302.00093](https://arxiv.org/abs/2302.00093): adding irrelevant information sharply lowers accuracy. Partial mitigations are an "ignore irrelevant information" instruction and self-consistency.
- GSM-Symbolic ([Mirzadeh et al., ICLR 2025, arXiv 2410.05229](https://arxiv.org/abs/2410.05229)): one added clause that seems relevant but isn't caused drops of up to 65% across state-of-the-art models.
- [Lou & Sun, 2024, arXiv 2412.06593](https://arxiv.org/abs/2412.06593): LLMs are sensitive to biased hints, and chain-of-thought, reflection, and "ignore the hint" instructions were *not sufficient* to remove the effect. The fix is to remove the hint, not to warn about it.

**Fixes:** 4.

### 9. Keep the system prompt short; put each rule where it is used

**Rule:** Keep a handful of numbered rules in the system prompt. Put "when to use / when not to use / what it returns" in each tool's description. Put the allowed (action, target) pairs and their preconditions in the decision-step message, generated from the manifest.

**Why:** Small models follow fewer instructions at once, and they favour the ones they read first. A rule placed next to the choice it governs is more likely to be applied than one buried 2,000 tokens earlier. This is the **instruction density** limit.

**Evidence:**
- IFScale ([Jaroslawicz et al., NeurIPS 2025, arXiv 2507.11538](https://arxiv.org/abs/2507.11538)): accuracy falls as the number of simultaneous instructions grows. Even the best frontier models reach only 68% at 500 instructions. Smaller or non-reasoning models (GPT-4o, Llama 4 Scout) decline *exponentially* rather than linearly. All models favour earlier instructions.
- *Tool Documentation Enables Zero-Shot Tool-Usage* ([Hsieh et al., 2023, arXiv 2308.00675](https://arxiv.org/abs/2308.00675)): good tool documentation alone matched few-shot demonstrations, and on large tool sets it was *more* valuable than demonstrations.
- Anthropic, [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents): "even small refinements to tool descriptions can yield dramatic improvements"; also use unambiguous parameter names.
- τ-bench policy ablation (Guideline 6): long policies are followed only in part.
- **No source gives a token budget for a ~3B-active model.** Engineering judgement: measure it. Delete half the rules and see whether anything gets worse (Part 4).

**Fixes:** 3, 4.

### 10. Use one or two short, contrasting worked examples, and make one of them a healthy case

**Rule:** If you add exemplars, add at most two compact ones: one healthy fleet ending in ABSTAIN, and one fault ending in a single targeted action. Rotate which fault class appears so no single action dominates.

**Why:** Examples teach the shape of a good answer quickly, but models also copy whatever answer the examples happen to show most, or showed last. If every example ends in a repair, "repair" becomes the default, which looks like your Failure 1. These are the **majority-label and recency biases** of few-shot prompting.

**Evidence:**
- *Calibrate Before Use* ([Zhao et al., ICML 2021, arXiv 2102.09690](https://arxiv.org/abs/2102.09690)): few-shot predictions are biased toward answers near the end of the prompt and toward common tokens. Calibration gained up to 30 points. *GPT-2/GPT-3 era*, but the bias mechanism is general.
- SWE-agent: removing its single demonstration cost 1.7 points (18.0 → 16.3). That is useful but small.
- Hsieh et al. (Guideline 9): documentation can substitute for demonstrations.
- **No study I found compares whole incident trajectories against rules for ops agents.** Full trajectories are long and add to the instruction-density problem, so prefer compressed exemplars that show only the final assessment table and decision.

**Fixes:** 1, 3.

### 11. Make tool calls forgiving: validate arguments and answer a bad call with a helpful error, never an abort

**Rule:** A tool call with missing or invalid arguments returns a tool result like `ERROR: metric_window requires 'target' (one of: target-a, target-b) and 'window_s' (int, 30–600)`, counts against the step budget, and the run continues. Where possible, give arguments safe defaults.

**Why:** One malformed call is a typo, not a failed investigation. A clear message lets the model fix it in one step.

**Evidence:** Anthropic, [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents) (helpful error messages, sensible defaults); SWE-agent's guardrail result (Guideline 2); CRITIC on external feedback (Guideline 5). The Agentless paper names mis-specified tool calls as a failure mode that compounds in agent loops.

**Fixes:** 6.

### 12. Measure consistency directly; treat disagreement as a reason to abstain, and vote only on the final decision

**Rule:** Report **pass^k**: the chance that all k repeated runs of a task succeed. If it is meaningfully below pass^1, either (a) sample the *decision step only* 2–3 times and act only on agreement, else escalate, or (b) fix the input variance. Do not vote over whole trajectories.

**Why:** Temperature 0 does not guarantee identical outputs on a serving stack. The batch your request lands in changes the arithmetic slightly, and one flipped token early can change the conclusion. When independent runs disagree, that disagreement is a good sign the model is unsure. This is **self-consistency** used as an **uncertainty signal**.

**Evidence:**
- τ-bench defines pass^k as the probability that all k i.i.d. trials succeed. gpt-4o scored pass^1 61.2 in retail, but pass^8 fell below 25%. **Being right once is not being reliable.**
- [Atil et al., 2024, arXiv 2408.04667](https://arxiv.org/abs/2408.04667): "deterministic" settings varied by up to 15% in accuracy across runs.
- Thinking Machines, [Defeating nondeterminism in LLM inference (He, 2025)](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/): the main cause is batch-size-dependent kernels. Qwen3-235B at temperature 0 gave 80 distinct completions out of 1,000. With batch-invariant kernels on vLLM all 1,000 were identical, at roughly 1.6× the runtime.
- Self-consistency ([Wang et al., ICLR 2023, arXiv 2203.11171](https://arxiv.org/abs/2203.11171)): +17.9 points on GSM8K. *This was large models (PaLM/UL2-scale).*
- **Caution for small models:** [Bahuguna, 2026, arXiv 2608.11403](https://arxiv.org/abs/2608.11403) found that majority voting *lowered* per-problem accuracy on most hard GPQA questions for 7–8B models. This is a single-author preprint on a different task, but it is a reason to use agreement as an *abstain gate* rather than trust the majority.
- [Kuhn et al., ICLR 2023, arXiv 2302.09664](https://arxiv.org/abs/2302.09664): agreement in meaning across samples (semantic entropy) predicts correctness better than baselines.

**Cost/benefit:** k=2 with "agree or escalate" doubles the cost of only the final call. It trades some recall (more ABSTAINs) for precision on actions. For an on-call agent, where a wrong restart is worse than a page to a human, that trade is usually correct.

**Fixes:** 3.

### 13. Judge every change on held-out variants, one change at a time

This is covered in Part 4. In short, agent benchmarks without real held-out sets produce brittle agents that learn shortcuts, and checking only the final answer overstates how well an agent diagnoses. Evidence: *AI Agents That Matter* ([Kapoor et al., 2024, arXiv 2407.01502](https://arxiv.org/abs/2407.01502)), Cloud-OpsBench (Guideline 4), and GSM-Symbolic (Guideline 8, small surface changes move scores).

---

## Part 2 — What not to do (patterns that hurt small models)

- **Don't let the model choose action and target in two independent free fields.** It will pair them wrongly (Guideline 2).
- **Don't put the answer field before the reasoning field in a JSON schema**, and don't apply a strict grammar from the first token of a reasoning step (Guideline 3, Tam et al.).
- **Don't ask the model to "verify your answer" with no new information.** Intrinsic self-correction doesn't help and can hurt (Huang et al.).
- **Don't keep re-sending the same retry.** At temperature 0 the same input gives roughly the same output. After one targeted retry, fall back to ABSTAIN.
- **Don't write suspicions into environment descriptions** ("X can be impaired"), and don't try to fix a planted hint by adding "ignore hints". Remove it (Lou & Sun; Shi et al.).
- **Don't encode safety rules only in prose.** Enforce them as preconditions and show the result (τ-bench policy ablation; AgentSpec).
- **Don't hand the model raw full dumps when a diff would do** (SWE-agent's full-file view scored worse than a 100-line window).
- **Don't add many tools with overlapping purposes** (Anthropic; *Less is More*).
- **Don't use only fault examples in few-shot prompts.** The model learns that "something is always broken" (Zhao et al.).
- **Don't trust majority voting by default at this size.** Use agreement as an abstain gate (Bahuguna; Kuhn et al.).
- **Don't let a single malformed tool call end the run** (Anthropic error-message guidance).
- **Don't report one run per task.** Report pass^k (τ-bench).
- **Don't tune prompts against the same cases you report on** (Kapoor et al.).

---

## Part 3 — Minimal change set (best expected gain per hour, in order)

These are written against the current code: `schemas/agent-decision.schema.json`, `nexus/agent/decision_format.py` (`decision_response_format`), and `nexus/agent/controller.py` (`_validate_decision`, `_final_format`). The current schema has a free `repair_plan.action.tool` string and a free `arguments` object, and `hypotheses[].supports` can be empty. That explains both the wrong-target errors and the "PLAN requires evidence for the leading hypothesis" contract failures.

### Change 1 — Replace the free action with a single manifest-derived enum, and split the schema by state

*Schema + `decision_response_format`.*

- In `decision_response_format`, build `move` as `{"type":"string","enum":[...]}` from the manifest, as `"<action>:<target>"` strings (for example `"drain-worker:target-b"`). Replace `repair_plan.action.{tool,arguments}` with `repair_plan.move`. The controller maps `move` back to `(tool, arguments)`.
- Make the top level an `anyOf` of two branches:
  - **ABSTAIN branch:** `state` const `"ABSTAIN"`, `repair_plan` const `null`.
  - **PLAN branch:** `state` const `"PLAN"`, `repair_plan` required and non-null, `hypotheses` `minItems: 1`, and `hypotheses.items.supports` `minItems: 1`.

  Because the schema cannot express "the *first* hypothesis has evidence", requiring `minItems: 1` on every hypothesis's `supports` in the PLAN branch is the practical version. That makes the "PLAN requires evidence for the leading hypothesis" error impossible to generate.
- Reorder properties so the reasoning-like fields come first: `assessments` (Change 2), `summary`, `hypotheses`, then `state`, then `repair_plan`. Constrained decoders emit properties in schema order.
- Before relying on it, check that your vLLM structured-output backend supports `anyOf`/`const` in this position. If it does not, use the two-call version: first a call constrained to `{"state": enum[PLAN, ABSTAIN]}` plus assessments, then a second call with the branch schema chosen by code.

Fixes 1, 2, 6. Sources: BFCL, Anthropic poka-yoke, Tam et al. (field order).

### Change 2 — Add a required per-resource `assessments` table and derive the allowed menu from it

*Schema field + controller step.*

Add to the schema, generated from the manifest:

```json
"assessments": {
  "type": "array", "minItems": N, "maxItems": N,
  "items": {
    "type": "object", "additionalProperties": false,
    "required": ["resource", "status", "fault_class", "evidence"],
    "properties": {
      "resource":    {"enum": ["target-a", "target-b", "...from manifest"]},
      "status":      {"enum": ["healthy", "degraded", "faulty", "unknown"]},
      "fault_class": {"enum": ["none", "config", "capacity", "link", "parser", "process", "...from manifest"]},
      "evidence":    {"type": "array", "items": {"enum": ["<issued evidence ids>"]}}
    }
  }
}
```

In `_validate_decision`, add these checks:

- (a) each resource appears exactly once;
- (b) if every status is `healthy`, then `state` must be `ABSTAIN`;
- (c) the `move` target must have `status ∈ {faulty, degraded}`;
- (d) the `move` action must be in the manifest's `remedies[fault_class]` for that target. For example, `link → drain-worker`, `config → apply-serving-profile`, `process → restart-worker`. This table lives in the environment manifest, so the controller stays neutral about the environment.

On a violation, raise a `ContractError` whose message names the exact mismatch, for example: `"summary/assessments mark target-a faulty (config) but move targets target-b; allowed moves for target-a/config: apply-serving-profile:target-a"`.

Fixes 1, 2, 3, 4. Sources: Flow-of-Action (structured judgement), Cloud-OpsBench (tie answers to evidence), CRITIC (feedback that names the problem).

### Change 3 — One targeted retry, then ABSTAIN; tool-argument errors become tool results

*Controller step.*

- In `parse_decision` and `_validate_decision`, keep exactly **one** retry, carrying the specific `ContractError` text from Change 2. If the retry still fails, return a synthesized `ABSTAIN` with `stop_reason = "contract_failure: <message>"` instead of failing the run. The referee scores it as an abstention, which is honest.
- In `tool_loop.py`, validate tool arguments against each tool's JSON schema *before* execution. On failure, append a tool result `{"error": "...missing 'target' (one of: ...); example: {...}"}`, count one step, and continue. Never raise.

Fixes 6. Sources: Huang et al. vs CRITIC, Anthropic error-message guidance.

### Change 4 — Annotate every menu item with executor preconditions and look-ahead, and drop infeasible ones

*Controller step + manifest.*

Before the decision call, for each candidate `move` the controller asks the executor's precondition check (a dry run) two things: (1) "is this allowed now?" and (2) "after this, are the repairs for every *other* non-healthy resource still allowed?"

- Remove moves that fail (1) from the enum.
- Keep moves that fail (2), but list them in the decision message with a plain note, for example: `drain-worker:target-b — allowed, but afterwards target-a cannot be repaired (it would be the last serving replica). Prefer repairing target-a first.`
- Optionally, add a controller rule: when several resources are faulty and one order is feasible but another is not, remove the moves that begin an infeasible order.

With two workers and three actions this is a few dry-run calls. The safety rule leaves the prompt and becomes a fact the model reads next to its choice.

Fixes 5 (and reduces 3). Sources: τ-bench policy ablation, AgentSpec, Kubernetes PDB.

### Change 5 — Remove the hint from the manifest and add two contrastive tools

*Manifest + tool change.*

- In the environment description, replace "target-b is reached through a network proxy that can be impaired" with a neutral topology fact: `"target-b: traffic path = haproxy → proxy-b → worker-b. target-a: haproxy → worker-a."` Put "link" in the shared `fault_class` enum, which applies to every resource.
- Add `compare_config(keys?: list)`: it returns only the configuration keys whose values differ across workers. If nothing differs, it says `"no differences in N keys compared"`, so "identical" becomes a claim the model can cite as evidence.
- Add `compare_paths()`: for each worker, it returns probe latency and errors measured directly and through the load balancer/proxy, side by side, plus the difference between them.

In each tool's description, say *when to use it* ("call first when two workers behave differently") and *what it does not tell you*.

Fixes 4 (and 3). Sources: Shi et al., GSM-Symbolic, Lou & Sun (hints), SWE-agent summarized search, Anthropic tool design.

**Just outside the top 5:** a "decide twice, act only on agreement, else escalate" step on the final call (Guideline 12), and turning reasoning mode on for the decision call with the schema applied only to `content` (Guideline 3). Add each only if pass^k (Part 4) shows it is needed, and measure each on its own.

---

## Part 4 — Evaluation plan that keeps the held-out comparison honest

The risk: every change above was inspired by six specific logged failures. If you re-run those six cases, you will see improvement whether or not the agent generalizes. The plan below keeps the cases you tune on separate from the cases you report on, and attributes each gain to one change.

1. **Freeze three sets before touching code.**
   - **Dev set (v1):** the scenarios that produced Failures 1–6. You may look at these freely while editing.
   - **Held-out set (v2):** new scenario instances written *before* the changes and not run until the end. Cover every fault class on *each* worker, at least two healthy-fleet cases, both orders of every double fault, and one fault class that never appears in v1. Store it separately and do not read its traces while tuning.
   - **Unchanged regression set:** scenarios the old agent already solved. Report them before and after, to catch fixes that break working behaviour.
2. **Perturbation tests** (cheap, high value; the idea follows GSM-Symbolic: same problem, different surface):
   - **Name swap:** relabel target-a ↔ target-b, and rename both to neutral names (worker-1/worker-2). A correct agent's decision should follow the swap. This directly tests Failure 2 and any built-in bias toward "b".
   - **Hint wording:** run each v2 case with the neutral manifest and with the old suggestive sentence. The gap measures how much the hint still biases the model (Failure 4).
   - **Value jitter:** slightly change metric values and timestamps while keeping the ground truth fixed (Failure 3).
3. **Repeat runs and pass^k.** Run each task k=5 times under the *same* serving concurrency. Report pass^1 and pass^5 (τ-bench definition). For a cleaner measurement of the model alone, optionally run once with batch-invariant/deterministic kernels; this separates model indecision from server noise (Thinking Machines).
4. **Metrics to report**, in a separate column for each set:
   - target accuracy;
   - action-class accuracy;
   - false-action rate on healthy fleets (Failure 1);
   - ABSTAIN precision and recall;
   - multi-fault completion rate (Failure 5);
   - contract-failure / abort rate (Failure 6);
   - evidence closure: did the cited evidence actually support the move? (Cloud-OpsBench's point that correct answers often lack grounding);
   - tokens, latency, and model calls per incident (Kapoor et al.: report cost alongside accuracy).
5. **Attribute each gain to one change.** Apply Changes 1–5 one at a time, in order, and record the metric table after each (a cumulative ablation). Then do **leave-one-out** from the full set: remove each change alone and re-measure. A change that helps cumulatively but costs nothing when removed was riding on another change.
6. **The referee stays independent.** Keep it a deterministic outcome check: did the fleet recover, and did the action respect policy? Never ask the agent model. If you add any model-graded metric, use a different model family, and spot-check it by hand.
7. **One look at v2.** Run the held-out set once with the final configuration and once with the original. If you then change anything because of v2 results, v2 has become a dev set: write a v3 before you claim generalization.
8. **Report honestly.** Show baseline vs final on dev, v2, and regression, with pass^5 next to pass^1. Include the cases that still fail, and state that the evidence base for several guidelines is frontier-model or engineering judgement (see each guideline's evidence notes).

---

## Sources (all fetched and checked on 2026-10-18)

- Agentless — https://arxiv.org/abs/2407.01489
- SWE-agent — https://arxiv.org/abs/2405.15793 (ablation numbers from the HTML version)
- τ-bench — https://arxiv.org/abs/2406.12045
- BFCL (ICML 2025) — https://proceedings.mlr.press/v267/patil25a.html ; leaderboard https://gorilla.cs.berkeley.edu/leaderboard.html
- ToolLLM / ToolBench — https://arxiv.org/abs/2307.16789 (a large-scale tool-use dataset; not specifically about last-mile decision reliability, so not used for a guideline)
- Anthropic, Building effective agents — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, Writing effective tools for agents — https://www.anthropic.com/engineering/writing-tools-for-agents
- Let Me Speak Freely? — https://arxiv.org/abs/2408.02442 ; rebuttal https://blog.dottxt.ai/say-what-you-mean.html
- CRANE — https://arxiv.org/abs/2502.09061
- vLLM structured outputs — https://docs.vllm.ai/en/latest/features/structured_outputs.html
- Flow-of-Action — https://arxiv.org/abs/2502.08224
- Blueprint First, Model Second — https://arxiv.org/abs/2508.02721
- Small LLMs Are Weak Tool Learners — https://arxiv.org/abs/2401.07324
- Cloud-OpsBench — https://arxiv.org/abs/2603.00468
- ORCA-bench (on-call RCA, frontier agents; context only) — https://arxiv.org/abs/2607.28545
- LLMs Cannot Self-Correct Reasoning Yet — https://arxiv.org/abs/2310.01798
- CRITIC — https://arxiv.org/abs/2305.11738
- AgentSpec — https://arxiv.org/abs/2503.18666
- Kubernetes disruptions / PDB — https://kubernetes.io/docs/concepts/workloads/pods/disruptions/
- Less is More (tool selection, edge) — https://arxiv.org/abs/2411.15399
- Distracted by irrelevant context — https://arxiv.org/abs/2302.00093
- GSM-Symbolic — https://arxiv.org/abs/2410.05229
- Anchoring bias in LLMs — https://arxiv.org/abs/2412.06593
- IFScale — https://arxiv.org/abs/2507.11538
- Tool documentation enables zero-shot tool use — https://arxiv.org/abs/2308.00675
- Calibrate Before Use — https://arxiv.org/abs/2102.09690
- Self-consistency — https://arxiv.org/abs/2203.11171
- When Self-Consistency Backfires (small models) — https://arxiv.org/abs/2608.11403
- Semantic uncertainty — https://arxiv.org/abs/2302.09664
- Non-determinism of deterministic settings — https://arxiv.org/abs/2408.04667
- Defeating nondeterminism in LLM inference — https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/
- AI Agents That Matter — https://arxiv.org/abs/2407.01502
- Nemotron 3 Nano 30B-A3B model card — https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16

**Searched for but not found:** a direct study of per-entity assessment tables on small models; any study of how many format retries pay off; any LLM evaluation of repair ordering under capacity constraints; any study of contrastive (direct vs proxied) probe tools; and any published evaluation of a ~3B-active MoE model on an ops/RCA agent benchmark. The guidelines that depend on these are marked as engineering judgement.
