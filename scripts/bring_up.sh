#!/usr/bin/env bash
# Start shared infrastructure and one healthy target worker.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

python3 -m pip install -q -r requirements.txt
docker network inspect "${NEXUS_NETWORK:-nexus}" >/dev/null 2>&1 || docker network create "${NEXUS_NETWORK:-nexus}"
docker compose -f runtime/compose/docker-compose.yml up -d

# Start workers one at a time: concurrent vLLM startups can misread free GPU memory.
python3 -m nexus.target.manager up a qwen3-4b.healthy --port 8101
python3 -m nexus.target.manager status
