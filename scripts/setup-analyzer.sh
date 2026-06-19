#!/usr/bin/env bash
# Velyos Deck — reproducible setup for the OPTIONAL analyzer / stem-separation venv.
#
# The core app (download orchestration, library, jobs, DJ deck) runs from the
# main ./run.sh and does NOT need this. Run this script only if you want the
# heavy, optional features:
#   - BPM / key / Camelot analysis (librosa, numpy)
#   - Shazam track identification (shazamio)
#   - Stem separation (Demucs/Torch)         -> pass --demucs
#   - Audio super-resolution (AudioSR)        -> pass --audiosr
#
# These live in a SEPARATE Python 3.11 venv (.analyzer-venv) on purpose:
# librosa/Torch pin heavy, version-sensitive deps that we keep isolated from the
# lightweight FastAPI backend venv (.venv).
set -e

cd "$(dirname "$0")/.."

WANT_DEMUCS=0
WANT_AUDIOSR=0
for arg in "$@"; do
  case "$arg" in
    --demucs) WANT_DEMUCS=1 ;;
    --audiosr) WANT_AUDIOSR=1 ;;
    --all) WANT_DEMUCS=1; WANT_AUDIOSR=1 ;;
    *) echo "Unknown flag: $arg (use --demucs, --audiosr, or --all)"; exit 1 ;;
  esac
done

# Demucs/Torch and AudioSR carry model + runtime licenses that need review before
# redistribution. We only install them on explicit opt-in.
find_py311() {
  local candidates=(
    "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11"
    "/opt/homebrew/bin/python3.11"
    "/usr/local/bin/python3.11"
    "$(command -v python3.11 2>/dev/null || true)"
  )
  for p in "${candidates[@]}"; do
    [ -x "$p" ] || continue
    echo "$p"; return 0
  done
  return 1
}

PY311="$(find_py311)" || {
  echo "Python 3.11 not found. The analyzer venv requires 3.11 (librosa/Torch compat)."
  echo "Install it, e.g.:  brew install python@3.11"
  exit 1
}

VENV="$PWD/.analyzer-venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "Creating analyzer venv (.analyzer-venv) with $PY311 ..."
  "$PY311" -m venv "$VENV"
fi

echo "Installing analyzer packages (librosa, numpy, shazamio) ..."
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install -r requirements-analyzer.txt

if [ "$WANT_DEMUCS" = "1" ]; then
  echo "Installing Demucs (Torch) — large download ..."
  "$VENV/bin/pip" install demucs
fi

if [ "$WANT_AUDIOSR" = "1" ]; then
  echo "Installing AudioSR — large download ..."
  "$VENV/bin/pip" install audiosr
fi

echo
echo "Done. Optional features available:"
"$VENV/bin/python" -c "import importlib.util as u; print('  librosa  :', 'yes' if u.find_spec('librosa') else 'no'); print('  shazamio :', 'yes' if u.find_spec('shazamio') else 'no')"
[ -x "$VENV/bin/demucs" ] && echo "  demucs   : yes" || echo "  demucs   : no (rerun with --demucs)"
"$VENV/bin/python" -c "import importlib.util as u; print('  audiosr  :', 'yes' if u.find_spec('audiosr') else 'no (rerun with --audiosr)')"
