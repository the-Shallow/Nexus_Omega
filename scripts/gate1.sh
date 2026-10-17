#!/usr/bin/env bash
# Gate 1: healthy canary passes, injected silent fault fails the canary while
# /health stays 200, rollback restores a passing canary. Run after bring_up.sh.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

FAULT="${1:-qwen3-4b.wrong-parser}"
URL="http://localhost:8101"
MODEL="${MODEL:-qwen3-4b}"   # served name of the profile currently on worker a
RUN="artifacts/runs/gate1-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$RUN"

echo "== 1. healthy baseline =="
python3 -m nexus.verifier.canary --url "$URL" --model "$MODEL" --repeat 3 --out "$RUN/1-healthy.json" || { echo "baseline failed; fix before injecting"; exit 1; }

echo "== 2. inject $FAULT =="
change=$(python3 -m nexus.target.manager apply a "$FAULT")
echo "$change" | tee "$RUN/2-change.json"
change_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["change_id"])' <<<"$change")

echo "== 3. broken: expect health 200 and canary FAIL =="
python3 -m nexus.verifier.canary --url "$URL" --model "$MODEL" --repeat 3 --raw --out "$RUN/3-broken.json" \
  && echo "WARNING: canary passed under fault; fault did not reproduce"

echo "== 4. rollback $change_id =="
python3 -m nexus.target.manager rollback a "$change_id" | tee "$RUN/4-rollback.json"

echo "== 5. recovered: expect canary PASS =="
python3 -m nexus.verifier.canary --url "$URL" --model "$MODEL" --repeat 3 --out "$RUN/5-recovered.json"
echo "evidence in $RUN"
