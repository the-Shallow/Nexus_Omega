#!/usr/bin/env bash
# Start shared infrastructure and two healthy target workers.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

python3 -m pip install -q -r requirements.txt
docker network inspect "${NEXUS_NETWORK:-nexus}" >/dev/null 2>&1 || docker network create "${NEXUS_NETWORK:-nexus}"
docker compose -f runtime/compose/docker-compose.yml up -d

# Start workers one at a time: concurrent vLLM startups can misread free GPU memory.
PROFILE="${NEXUS_TARGET_PROFILE:-qwen25-coder-7b.tools-template}"
python3 -m nexus.target.manager up a "$PROFILE" --port 8101
python3 -m nexus.target.manager up b "$PROFILE" --port 8102
python3 -m nexus.target.manager status
