#!/usr/bin/env bash
# Start (or restart) the box operator app on 127.0.0.1:8130 from the 3.11 venv.
# It serves run records to the UI and starts named faults as episodes ("Break it").
# Creates NEXUS_OPERATOR_TOKEN in .env if it is missing. The agent never gets this
# token. Kept apart from environment_up.sh so restarting the agent's API never
# kills an episode in flight.
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-/ephemeral/venvs/nexus/bin/python}"
touch .env
grep -q '^NEXUS_OPERATOR_TOKEN=' .env || echo "NEXUS_OPERATOR_TOKEN=$(openssl rand -hex 16)" >> .env
set -a && . ./.env && set +a

PIDFILE=runtime/state/operator.pid
mkdir -p runtime/state artifacts
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  active=$(curl -sf -H "Authorization: Bearer $NEXUS_OPERATOR_TOKEN" localhost:8130/health | sed -n 's/.*"active_job":"\([^"]*\)".*/\1/p')
  [ -n "$active" ] && { echo "operator app is running $active; not restarting" >&2; exit 1; }
  kill "$(cat "$PIDFILE")"; sleep 1
fi
nohup "$PYTHON" -m uvicorn apps.operator.main:app --host 127.0.0.1 --port 8130 \
  > artifacts/operator.log 2>&1 &
echo $! > "$PIDFILE"
for _ in $(seq 30); do
  curl -sf -H "Authorization: Bearer $NEXUS_OPERATOR_TOKEN" localhost:8130/health >/dev/null \
    && { echo "operator app up on 127.0.0.1:8130 (pid $(cat "$PIDFILE"))"; exit 0; }
  sleep 1
done
echo "operator app did not start; see artifacts/operator.log" >&2; exit 1
