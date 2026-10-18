#!/usr/bin/env bash
# Start (or restart) the Brev environment API on 127.0.0.1:8120 from the 3.11 venv.
# Creates NEXUS_ENVIRONMENT_API_KEY (agent reads) and NEXUS_EXECUTOR_TOKEN
# (runner applies) in .env if they are missing.
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-/ephemeral/venvs/nexus/bin/python}"
touch .env
grep -q '^NEXUS_ENVIRONMENT_API_KEY=' .env || echo "NEXUS_ENVIRONMENT_API_KEY=$(openssl rand -hex 16)" >> .env
grep -q '^NEXUS_EXECUTOR_TOKEN=' .env || echo "NEXUS_EXECUTOR_TOKEN=$(openssl rand -hex 16)" >> .env
set -a && . ./.env && set +a

PIDFILE=runtime/state/environment.pid
mkdir -p runtime/state artifacts
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then kill "$(cat "$PIDFILE")"; sleep 1; fi
nohup "$PYTHON" -m uvicorn apps.environment.main:app --host 127.0.0.1 --port 8120 \
  > artifacts/environment.log 2>&1 &
echo $! > "$PIDFILE"
for _ in $(seq 30); do curl -sf localhost:8120/health >/dev/null && { echo "environment API up on 127.0.0.1:8120 (pid $(cat "$PIDFILE"))"; exit 0; }; sleep 1; done
echo "environment API did not start; see artifacts/environment.log" >&2; exit 1
