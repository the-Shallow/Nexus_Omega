# Research prompt: designing tool-calling workflows that a ~30B model executes reliably

You are an AI researcher who specializes in LLM agents, tool use, and the reliability of small and mid-size open models (3B–33B active or total parameters). Write a practitioner's evidence review: what is *known to work* when you design the workflow, tools, prompts, and output contracts for an agent built on a model of that size, and what is folklore. The reader will apply it the same day, so be concrete and cite sources.

## The system the findings will be applied to

- **Task.** An on-call agent for a self-hosted LLM inference fleet: two vLLM workers behind HAProxy, metrics in Prometheus. It receives a monitoring snapshot (route probe through the load balancer, a tool-call canary per worker), investigates with read-only tools (describe environment, resource state, configuration keys, metrics over a window, bounded logs, probes, probe artifacts), and ends with a JSON decision: `PLAN` with one repair action from a declared list (`apply-serving-profile`, `drain-worker`, `restart-worker`), or `ABSTAIN`. A runtime enforces policy, an executor applies the action, and an independent referee scores the outcome. The model never grades itself.
- **Model.** NVIDIA Nemotron 3.5 Lightning (~30B total, ~3B active MoE, NVFP4) on vLLM, temperature 0, with tool calling and `response_format` JSON-schema constrained decoding available. The final product must stay ≤33B parameters, so no larger model may be used as judge or helper at run time.
- **Observed failures** (each is real, from logged runs):
  1. *No-fault case:* on a healthy fleet it wrote "both targets healthy, no abnormalities" and still proposed `restart-worker`. Its words and its action contradict each other.
  2. *Wrong target:* in the summary it named worker **a** as misconfigured, then targeted worker **b** with the repair.
  3. *Wrong action class:* on a link fault it sometimes drains the worker (correct mitigation) and sometimes restarts it (cannot help), varying across runs at temperature 0.
  4. *Misattribution from a hint:* the environment description says "target-b is reached through a network proxy that can be impaired". It labeled a worker-side capacity fault (a vLLM concurrency cap) as a network fault, and called the two configurations "identical" without requesting the one key that differed.
  5. *Ordering:* with two simultaneous faults (a broken parser on a, a slow link on b), it acted on b first. That made a unrepairable, because a repair drains its worker and the executor refuses to drain the last serving one.
  6. *Contract failures:* despite constrained decoding on a retry, some runs end with "PLAN requires evidence for the leading hypothesis", and one malformed tool call (missing required arguments) used to abort the run.
  7. *Strength:* free-text diagnosis is usually right; the failures concentrate in the last mile (target, action choice, exact format, knowing when to do nothing).

## Questions to answer

1. **Workflow shape.** For models of this size, when does a fixed workflow (classify → targeted checks → decide; e.g. Agentless, Anthropic's "workflows vs agents") beat open-ended ReAct exploration, and by how much? What hybrid designs keep generality (the controller is environment-neutral: environments publish a manifest of resources, probes, metrics, and actions) while constraining the model's choices?
2. **Tool and action design (the agent–computer interface).** Evidence on tool descriptions (when to use, when *not* to use, preconditions, side effects), the number and granularity of tools, composite or "diff" tools that return what differs rather than what was asked, contrastive probes (e.g. direct vs. through-proxy latency), and explicit null actions ("no fault found"). SWE-agent's ACI findings, Anthropic's "Writing effective tools for agents", Gorilla/BFCL irrelevance detection, τ-bench, ToolBench, and anything newer.
3. **Structured intermediate reasoning.** Does forcing a per-entity assessment (each resource: status, symptom, evidence) or a differential diagnosis table before the action improve target and action accuracy for small models? What about decomposing one call into two: "diagnose" with a schema, then "choose action" constrained to the diagnosis?
4. **Output contracts and constrained decoding.** Best practice for JSON-schema constraints with small models: what to encode in the schema (enums, minItems, conditional requirements, consistency between fields) versus validate after the fact; the cost to reasoning quality of constraining too early; retry-with-error-feedback patterns and how many retries pay off.
5. **Consistency and determinism.** At temperature 0 with live, slightly varying inputs, decisions flip. Evidence for self-consistency voting, majority over k samples, or "decide twice and require agreement, else escalate", and their cost/benefit at this model size. Report pass^k-style metrics.
6. **Prompting.** Few-shot exemplars of whole incident trajectories versus rules; symptom→test checklists; how much system-prompt text a ~3B-active model can actually follow; placement (system vs. tool descriptions vs. manifest); how not to plant hints that bias diagnosis (failure 4).
7. **Multi-fault and ordering.** Patterns for prioritizing among several faults under safety constraints (capacity preservation, "never remove the last healthy replica"): planning over a dependency graph, or exposing the constraint as an action precondition.
8. **Evaluation hygiene.** How to improve an agent on observed failures without overfitting the test set: held-out v2 sets, perturbation tests, reporting before/after on unchanged tasks, and attribution of each gain to one change (ablations).

## Deliverable

- A ranked list of **10–15 design guidelines**. For each one: the rule in one sentence, the evidence (paper, benchmark, or vendor guidance, with a link, and with the model size where known), the expected effect size if reported, and which of the observed failures 1–6 it addresses.
- A short **"what not to do"** list (patterns that hurt small models).
- A **minimal change set** for the system above: the 5 changes with the best expected gain per hour of work, in priority order, each phrased as a concrete edit (prompt text, schema field, tool or manifest change, or controller step).
- An **evaluation plan** that keeps the held-out comparison honest after these changes.

Prefer peer-reviewed or reproducible results from 2023–2026. Say clearly when evidence comes only from frontier-scale models and may not transfer. Do not invent citations: if you cannot find support for a claim, say so.
