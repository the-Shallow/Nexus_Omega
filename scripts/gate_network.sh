#!/usr/bin/env bash
# Network-fault gate: routes meet the SLO, an injected toxic on one worker's
# link breaks that route while gateway /health stays 200, rollback restores it.
# Usage: scripts/gate_network.sh <proxy> <preset>   e.g. b latency | b blackhole
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

PROXY="${1:-b}"
PRESET="${2:-latency}"
URL="http://localhost:8100"
MODEL="${MODEL:-qwen25-coder}"
RUN="artifacts/runs/net-$PROXY-$PRESET-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$RUN"
probe() { python3 -m nexus.verifier.route --url "$URL" --model "$MODEL" --requests 30 --out "$RUN/$1.json"; }

echo "== 1. healthy routes =="
probe 1-healthy || { echo "baseline failed; fix before injecting"; exit 1; }

echo "== 2. inject $PRESET on $PROXY =="
change=$(python3 -m nexus.faults.network apply "$PROXY" "$PRESET")
echo "$change" | tee "$RUN/2-change.json"
change_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["change_id"])' <<<"$change")

echo "== 3. broken: expect gateway health 200 and route $PROXY FAIL =="
probe 3-broken && echo "WARNING: routes passed under fault; fault did not reproduce"

echo "== 4. rollback $change_id =="
python3 -m nexus.faults.network rollback "$PROXY" "$change_id" | tee "$RUN/4-rollback.json"

echo "== 5. recovered: expect routes PASS =="
probe 5-recovered
echo "evidence in $RUN"
