# Nexus Ω

Nexus Ω is a self-healing inference-service demonstrator for the NVIDIA × Red Hat Small Models Hack.

One NVIDIA Nemotron 3.5 Lightning agent diagnoses reproducible Red Hat vLLM incidents, chooses bounded tools, applies an operational repair or a small source patch, and proves recovery. A SimPy shadow model visualizes request flow and estimates the effect of operational actions before they touch the live service. NeMo Gym supplies reproducible episodes and deterministic verifiers.

The project deliberately targets the Tool-Calling track: reliable tool selection, valid arguments, failure recovery, verification, rollback, and safe abstention.

## Start here

- [Final hackathon plan](docs/hackathon-plan.md)
- [Issue-dataset schema](data/README.md)
- [Curated issue candidates](data/issue-candidates.csv)

## Proposed repository layout

```text
nexus-omega/
├── apps/
│   ├── api/                    # FastAPI control plane and event stream
│   └── ui/                     # Live incident, simulation, action, verification views
├── nexus/
│   ├── agent/                  # State machine, prompts, context selection, policy
│   ├── tools/                  # Typed read/test/act/rollback tools
│   ├── simulator/              # SimPy shadow model and candidate-action evaluator
│   ├── verifier/               # Functional, SLO, patch-test, and safety checks
│   └── certificate/            # Machine-readable recovery certificate
├── environments/
│   └── serveops/               # NeMo Gym resource server, tasks, and verifier
├── incidents/
│   └── <incident-id>/          # Manifest, injector, fixture, oracle, cleanup
├── runtime/
│   ├── compose/                # Gateway, two vLLM workers, metrics, UI
│   └── redhat-vllm/            # Pinned Red Hat image/configuration
├── data/                       # Provenance-preserving incident catalog and splits
├── evals/                      # Baselines, ablations, held-out runs
├── scripts/                    # Bring-up, smoke test, demo, and reset entry points
├── artifacts/                  # Certificates, plots, traces, and submission assets
└── docs/                       # Architecture, runbook, demo script, decisions
```

## Non-goals for the hackathon

- A faithful physical datacenter model.
- Kubernetes, multi-node Dynamo, or autonomous privileged shell access.
- Training Nemotron from scratch.
- Claiming that a simulated repair succeeded without verifying it on the real target.
- Supporting arbitrary repositories or unrestricted source changes.

