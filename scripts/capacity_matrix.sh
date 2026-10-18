#!/usr/bin/env bash
# Capacity experiments on one worker, measured directly (the other worker idle).
# For each profile: apply it to worker a, sweep two workloads, record.
# Restores worker a to the default profile at the end.
# Output: artifacts/load/cap-<profile>-<workload>.{json,csv}
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

DEFAULT=qwen25-coder-7b.tools-template
PROFILES="${PROFILES:-$DEFAULT qwen25-coder-7b.cap-mem40 qwen25-coder-7b.cap-fp8 qwen25-coder-7b.cap-kvfp8 qwen25-coder-7b.cap-noprefix}"
STREAMS="${STREAMS:-32,64,128,256}"
declare -A WORKLOADS=(
  [plain]="kind=synthetic_text,prompt_tokens=256,output_tokens=128"
  [toolshaped]="kind=synthetic_text,prompt_tokens=128,output_tokens=128,prefix_count=4,prefix_tokens=1024"
)
trap 'python3 -m nexus.target.manager apply a "$DEFAULT" >/dev/null' EXIT

for profile in $PROFILES; do
  echo "== $profile"
  python3 -m nexus.target.manager apply a "$profile" | python3 -c 'import json,sys; print("ready in", json.load(sys.stdin)["ready_seconds"], "s")'
  for workload in "${!WORKLOADS[@]}"; do
    name="cap-${profile#qwen25-coder-7b.}-$workload"
    TARGET=http://nexus-a:8000 DATA="${WORKLOADS[$workload]}" bash scripts/load_sweep.sh "$name" "$STREAMS" 30 >/dev/null 2>&1 \
      && echo "   $workload ok" || echo "   $workload FAILED"
  done
done
