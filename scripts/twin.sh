#!/usr/bin/env bash
# Start the Nexus Ω digital twin at http://127.0.0.1:${TWIN_PORT:-8765}
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x .venv/bin/python ]; then
  uv venv .venv --python 3.13 -q
  uv pip install --python .venv/bin/python -q "simpy>=4.1" "fastapi>=0.115" "uvicorn[standard]>=0.30" "pytest>=8"
fi
exec .venv/bin/uvicorn apps.twin.server:app --host 127.0.0.1 --port "${TWIN_PORT:-8765}" --log-level warning
