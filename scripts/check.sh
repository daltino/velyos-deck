#!/usr/bin/env bash
set -euo pipefail

python3 -m py_compile analyzer.py dj_server.py midi_bridge.py phone_server.py backend/main.py backend/dj_core.py

for f in dj/*.js; do
  node --check "$f" || exit 1
done

node --test tests/*.test.js

if [ -d web/node_modules ]; then
  (cd web && npm run typecheck && npm run build)
else
  echo "web/node_modules is missing; run 'cd web && npm ci' before scripts/check.sh" >&2
  exit 1
fi

git diff --check
