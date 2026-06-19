#!/usr/bin/env bash
# SCDL GUI DJ OS — local web launcher
set -e

cd "$(dirname "$0")"

# Find a usable python3 for the local web backend.
find_python() {
  local candidates=(
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"
    "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3"
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3"
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
    "/usr/bin/python3"
    "$(command -v python3 2>/dev/null || true)"
  )
  for p in "${candidates[@]}"; do
    [ -x "$p" ] || continue
    if "$p" -c "import sqlite3, venv" >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

PY="$(find_python)" || {
  echo "Nenašel jsem použitelný Python 3."
  echo "Nainstaluj Python z https://www.python.org/downloads/."
  exit 1
}

VENV="$PWD/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "Připravuji lokální Python prostředí…"
  "$PY" -m venv --clear "$VENV"
fi
if ! "$VENV/bin/python" -c "import fastapi, uvicorn, websockets, mutagen" >/dev/null 2>&1; then
  "$VENV/bin/pip" install -r requirements.txt
fi
PY="$VENV/bin/python"

if [ -f "$PWD/web/package.json" ] && command -v npm >/dev/null 2>&1; then
  if [ ! -d "$PWD/web/node_modules" ]; then
    echo "Připravuji web dependencies…"
    (cd "$PWD/web" && npm install)
  fi
  if [ ! -f "$PWD/web/dist/index.html" ] || [ "$PWD/web/src/main.tsx" -nt "$PWD/web/dist/index.html" ]; then
    echo "Sestavuji web UI…"
    (cd "$PWD/web" && npm run build)
  fi
fi

if ! command -v scdl >/dev/null 2>&1; then
  echo "scdl není v PATH — instaluji přes pipx…"
  if ! command -v pipx >/dev/null 2>&1; then
    brew install pipx
  fi
  pipx install scdl
  pipx ensurepath >/dev/null 2>&1 || true
  export PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg chybí — nainstaluj přes: brew install ffmpeg"
  exit 1
fi

exec "$PY" -m backend.main
