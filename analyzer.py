#!/usr/bin/env python3
"""Audio analyzer: BPM, key (Krumhansl-Schmuckler), optional Shazam.

Spouští se vlastním Python 3.11 venv interpretérem (scdl-gui/.analyzer-venv).
Vstup: <command> <path>. Výstup: JSON na stdout.
"""
import asyncio
import json
import sys
from pathlib import Path


PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

CAMELOT = {
    "C major": "8B", "G major": "9B", "D major": "10B", "A major": "11B",
    "E major": "12B", "B major": "1B", "F# major": "2B", "C# major": "3B",
    "G# major": "4B", "D# major": "5B", "A# major": "6B", "F major": "7B",
    "A minor": "8A", "E minor": "9A", "B minor": "10A", "F# minor": "11A",
    "C# minor": "12A", "G# minor": "1A", "D# minor": "2A", "A# minor": "3A",
    "F minor": "4A", "C minor": "5A", "G minor": "6A", "D minor": "7A",
}


def normalize_dj_bpm(raw_bpm: float) -> tuple[float, float]:
    """Return a DJ-friendly BPM and multiplier while preserving raw tempo."""
    bpm = float(raw_bpm)
    mult = 1.0
    while bpm < 95:
        bpm *= 2
        mult *= 2
    while bpm > 190:
        bpm /= 2
        mult /= 2
    return round(bpm, 1), mult


def detect_bpm_key(path: Path) -> dict:
    import librosa
    import numpy as np

    y, sr = librosa.load(str(path), sr=22050, mono=True, duration=180)
    out: dict = {}

    # BPM
    try:
        tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(tempo if not hasattr(tempo, "__len__") else tempo[0])
        norm_bpm, mult = normalize_dj_bpm(bpm)
        out["raw_bpm"] = round(bpm, 1)
        out["bpm"] = norm_bpm
        out["bpm_multiplier"] = mult
    except Exception as e:
        out["bpm_error"] = str(e)

    # Key (Krumhansl-Schmuckler key profile correlation)
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
        major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                          2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                          2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        best = ("?", -2.0)
        for i in range(12):
            for mode, profile in (("major", major), ("minor", minor)):
                rolled = np.roll(profile, i)
                num = float(np.corrcoef(rolled, chroma)[0, 1])
                if num > best[1]:
                    best = (f"{PITCH_NAMES[i]} {mode}", num)
        out["key"] = best[0]
        out["key_confidence"] = round(best[1], 3)
        out["camelot"] = CAMELOT.get(best[0], "?")
    except Exception as e:
        out["key_error"] = str(e)

    return out


async def shazam_identify(path: Path) -> dict:
    from shazamio import Shazam
    s = Shazam()
    res = await s.recognize(str(path))
    track = (res or {}).get("track") or {}
    return {
        "title": track.get("title"),
        "artist": track.get("subtitle"),
        "album": (
            (track.get("sections") or [{}])[0]
            .get("metadata", [{}])[0].get("text")
        ),
        "url": track.get("url") or track.get("share", {}).get("href"),
    }


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: analyzer.py <analyze|shazam> <path>"}))
        sys.exit(1)
    cmd, p = sys.argv[1], Path(sys.argv[2])
    if not p.is_file():
        print(json.dumps({"error": f"file not found: {p}"}))
        sys.exit(2)
    try:
        if cmd == "analyze":
            print(json.dumps({"path": str(p), **detect_bpm_key(p)}))
        elif cmd == "shazam":
            print(json.dumps({"path": str(p), **asyncio.run(shazam_identify(p))}))
        else:
            print(json.dumps({"error": f"unknown command: {cmd}"}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(3)


if __name__ == "__main__":
    main()
