#!/usr/bin/env bash
# Start the Nexus Ω digital twin at http://127.0.0.1:${TWIN_PORT:-8765}
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x .venv/bin/python ]; then
  uv venv .venv --python 3.13 -q
  uv pip install --python .venv/bin/python -q "simpy>=4.1" "fastapi>=0.115" "uvicorn[standard]>=0.30" "httpx>=0.27" "pytest>=8"
fi
# Venvs made before the live/results routes lack httpx.
.venv/bin/python -c "import httpx" 2>/dev/null || uv pip install --python .venv/bin/python -q "httpx>=0.27"
# Build the React platform once if Node is available; otherwise the static view is served.
if [ ! -f apps/web/dist/index.html ] && command -v npm >/dev/null 2>&1; then
  (cd apps/web && { [ -d node_modules ] || npm ci --silent; } && npm run build --silent) || echo "web build skipped; serving the static view"
fi
exec .venv/bin/uvicorn apps.twin.server:app --host 127.0.0.1 --port "${TWIN_PORT:-8765}" --log-level warning
