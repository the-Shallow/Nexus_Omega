#!/usr/bin/env bash
# BFCL on worker a under each serving profile (agentic-requirements section 10):
# same model, cases, decoding and seed; only the profile changes. Worker a is
# drained from HAProxy for the whole run and returned healthy at the end.
# Results: artifacts/bfcl/<profile>-<time>.json
#   scripts/bfcl_arms.sh [profile ...]
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
PY="${PYTHON:-/ephemeral/venvs/nexus/bin/python}"
HEALTHY=qwen25-coder-7b.tools-template
ARMS=("${@:-$HEALTHY qwen25-coder-7b.vllm-32926 qwen25-coder-7b.tools-stripped}")
admin() { curl -sf -X POST -H "Authorization: Bearer ${NEXUS_ADMIN_TOKEN:-}" "${NEXUS_ADMIN_URL:-http://localhost:8110}/admin/workers/a/$1" >/dev/null; }

admin drain
for arm in ${ARMS[@]}; do
  echo "== $arm =="
  "$PY" -m nexus.target.manager apply a "$arm" >/dev/null || { echo "apply failed: $arm"; continue; }
  "$PY" -m nexus.verifier.bfcl run --port 8101 --label "$arm"
done
"$PY" -m nexus.target.manager apply a "$HEALTHY" >/dev/null
admin undrain
echo "== worker a back on $HEALTHY, undrained =="
