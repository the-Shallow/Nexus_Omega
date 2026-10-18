#!/usr/bin/env bash
# Concurrency sweep through the gateway with guidellm. Produces the
# latency-vs-load curve used for the overload fault thresholds and the
# capacity numbers. Output: artifacts/load/<name>.{json,csv}
# Usage: scripts/load_sweep.sh [name] [streams] [seconds-per-step]
# DATA overrides the guidellm --data spec.
# TARGET overrides the endpoint (default: HAProxy, the fleet entry point), e.g. TARGET=http://nexus-a:8000
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

NAME="${1:-sweep-$(date +%Y%m%dT%H%M%S)}"
STREAMS="${2:-1,8,32,64,128,256}"
SECONDS_PER_STEP="${3:-30}"
MODEL="${MODEL:-qwen25-coder}"
TARGET="${TARGET:-http://haproxy:8100}"
DATA="${DATA:-kind=synthetic_text,prompt_tokens=256,output_tokens=128}"
TOKENIZER="${TOKENIZER:-Qwen/Qwen2.5-Coder-7B-Instruct}"
OUT="$PWD/artifacts/load"
mkdir -p "$OUT"

docker run --rm --network "${NEXUS_NETWORK:-nexus}" \
  -e HF_HOME=/hf -e HF_HUB_OFFLINE=1 -v "${HF_HOME:-$HOME/.cache/huggingface}:/hf:ro" -v "$OUT:/out" \
  nexus-guidellm:0.8.0 run \
  --backend "kind=openai_http,target=$TARGET,model=$MODEL" \
  --tokenizer "kind=hf_auto,model=$TOKENIZER" \
  --data "$DATA" \
  --profile kind=concurrent --override profile.streams "$STREAMS" \
  --constraint "kind=max_duration,seconds=$SECONDS_PER_STEP" \
  --output "kind=json,path=/out/$NAME.json" --output "kind=csv,path=/out/$NAME.csv" \
  --disable-progress
