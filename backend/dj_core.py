#!/usr/bin/env python3
"""Velyos Deck core audio helpers (local-file only).

These functions operate exclusively on audio files the user already has on disk:
analysis (via the optional analyzer venv), stem separation (Demucs), and ffmpeg
enhancement filter construction. They contain no streaming-download or online
platform logic — that lives in the optional, gitignored ``downloader_local``
module which is excluded from the public release.

Extracted from the legacy ``app.py`` so the FastAPI backend no longer depends on
the Tkinter app and so the public repository stays free of downloader code.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

AUDIO_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".opus", ".ogg"}

ANALYZER_PY = Path(__file__).resolve().parents[1] / ".analyzer-venv" / "bin" / "python"
ANALYZER_SCRIPT = Path(__file__).resolve().parents[1] / "analyzer.py"
DEMUCS_BIN = Path(__file__).resolve().parents[1] / ".analyzer-venv" / "bin" / "demucs"


def _find_cmd(name: str) -> list[str] | None:
    direct = shutil.which(name)
    if direct:
        return [direct]
    candidates = [
        Path.home() / ".local" / "bin" / name,
        Path("/opt/homebrew/bin") / name,
        Path.home() / "Library" / "Python" / "3.14" / "bin" / name,
        Path.home() / "Library" / "Python" / "3.13" / "bin" / name,
        Path.home() / "Library" / "Python" / "3.12" / "bin" / name,
    ]
    for p in candidates:
        if p.is_file() and os.access(p, os.X_OK):
            return [str(p)]
    return None


def find_audiosr() -> list[str] | None:
    return _find_cmd("audiosr")


def analyze_track(path: Path, timeout: int = 120) -> dict | None:
    """Run the analyzer venv to detect BPM/key/Camelot for a local file."""
    if not ANALYZER_PY.exists():
        return None
    try:
        out = subprocess.run(
            [str(ANALYZER_PY), str(ANALYZER_SCRIPT), "analyze", str(path)],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None
    line = (out.stdout or "").strip().splitlines()
    if not line:
        return None
    try:
        return json.loads(line[-1])
    except json.JSONDecodeError:
        return None


def stem_separate(in_path: Path, log_q) -> Path | None:
    """Run Demucs to split a local track into vocals/drums/bass/other.

    Returns the output folder containing the stems."""
    demucs = DEMUCS_BIN
    if not demucs.is_file():
        log_q.put("!! Demucs není nainstalovaný.\n")
        return None
    out_dir = in_path.parent / "_stems"
    out_dir.mkdir(exist_ok=True)
    cmd = [str(demucs), "-n", "htdemucs", "-o", str(out_dir), str(in_path)]
    log_q.put(f"$ {' '.join(cmd)}\n  (může trvat 1-3 min)\n")
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        log_q.put(f"!! demucs fail: {p.stderr.splitlines()[-1] if p.stderr else '?'}\n")
        return None
    # demucs writes to out_dir/htdemucs/<stem>/
    track_stem = in_path.stem
    result_dir = out_dir / "htdemucs" / track_stem
    return result_dir if result_dir.is_dir() else out_dir


def _parse_loudnorm_json(stderr: str) -> dict | None:
    import re
    matches = re.findall(r"\{[\s\S]*?\}", stderr or "")
    for raw in reversed(matches):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if "input_i" in data and "input_tp" in data:
            return data
    return None


def build_enhance_filter(opts: dict) -> str:
    """Build an ffmpeg -af filter chain from selected enhancements."""
    parts = []
    if opts.get("denoise"):
        parts.append("afftdn=nr=10:nf=-25")
    if opts.get("brightness"):
        # Psychoacoustic exciter — adds harmonics in high freq, "restores air"
        parts.append("aexciter=level_in=1:level_out=1:amount=2:drive=8.5:freq=7500:ceil=12000")
    if opts.get("stereo_widen"):
        parts.append("extrastereo=m=1.4:c=true")
    if opts.get("loudnorm"):
        parts.append("loudnorm=I=-14:LRA=11:TP=-1.0")
    return ",".join(parts)
