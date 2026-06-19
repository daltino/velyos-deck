#!/usr/bin/env python3
"""Local HTTP server for the DJ deck UI.

Serves static files from dj/ + JSON library + audio with HTTP Range support.
"""
from __future__ import annotations

import hashlib
import http.server
import json
import mimetypes
import os
import re
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Optional

try:
    from midi_bridge import NativeMidiBridge
except Exception:  # pragma: no cover - app must still serve without MIDI extras
    NativeMidiBridge = None  # type: ignore

DJ_DIR = Path(__file__).parent / "dj"
DEMUCS_BIN = Path(__file__).parent / ".analyzer-venv" / "bin" / "demucs"
DJ_STATE_PATH = Path.home() / ".music-dl-gui-dj-state.json"

# Stem generation jobs: {track_id: {status, error, started}}
_STEM_JOBS: dict[str, dict] = {}
_STEM_JOBS_LOCK = threading.Lock()


def _now() -> int:
    return int(time.time())


def _clean_set_name(name: str | None) -> str:
    text = re.sub(r"\s+", " ", str(name or "")).strip()
    return text[:80] or "PREP"


class DJStateStore:
    """Small JSON store for persistent browser-side set preparation."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self.data = self._load()

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        sets = data.get("sets")
        if not isinstance(sets, dict):
            sets = {}
        data = {
            "version": 1,
            "active_set": _clean_set_name(data.get("active_set") or "PREP"),
            "sets": sets,
        }
        if data["active_set"] not in data["sets"]:
            data["sets"][data["active_set"]] = self._new_set(data["active_set"], [])
        return data

    @staticmethod
    def _new_set(name: str, ids: list[str]) -> dict:
        ts = _now()
        return {
            "name": name,
            "ids": list(ids),
            "created_at": ts,
            "updated_at": ts,
        }

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2))
            tmp.replace(self.path)
        except OSError:
            pass

    @staticmethod
    def _filter_ids(ids: list[str], valid_ids: set[str]) -> list[str]:
        seen = set()
        out = []
        for tid in ids:
            if not isinstance(tid, str) or tid in seen or tid not in valid_ids:
                continue
            seen.add(tid)
            out.append(tid)
        return out

    def active_name(self) -> str:
        with self._lock:
            return _clean_set_name(self.data.get("active_set") or "PREP")

    def get_active_ids(self, valid_ids: set[str]) -> list[str]:
        with self._lock:
            name = self.active_name()
            row = self.data["sets"].setdefault(name, self._new_set(name, []))
            ids = self._filter_ids(row.get("ids") or [], valid_ids)
            if ids != row.get("ids"):
                row["ids"] = ids
                row["updated_at"] = _now()
                self._save()
            return list(ids)

    def set_active_ids(self, ids: list[str], valid_ids: set[str]) -> list[str]:
        with self._lock:
            name = self.active_name()
            row = self.data["sets"].setdefault(name, self._new_set(name, []))
            row["ids"] = self._filter_ids(ids, valid_ids)
            row["updated_at"] = _now()
            self._save()
            return list(row["ids"])

    def save_set(self, name: str | None, ids: list[str], valid_ids: set[str]) -> dict:
        with self._lock:
            clean = _clean_set_name(name)
            existing = self.data["sets"].get(clean)
            row = existing if isinstance(existing, dict) else self._new_set(clean, [])
            row["name"] = clean
            row["ids"] = self._filter_ids(ids, valid_ids)
            row.setdefault("created_at", _now())
            row["updated_at"] = _now()
            self.data["sets"][clean] = row
            self.data["active_set"] = clean
            self._save()
            return dict(row)

    def load_set(self, name: str | None, valid_ids: set[str]) -> list[str]:
        with self._lock:
            clean = _clean_set_name(name)
            row = self.data["sets"].setdefault(clean, self._new_set(clean, []))
            row["ids"] = self._filter_ids(row.get("ids") or [], valid_ids)
            row["updated_at"] = _now()
            self.data["active_set"] = clean
            self._save()
            return list(row["ids"])

    def get_set_ids(self, name: str | None, valid_ids: set[str]) -> tuple[str, list[str]]:
        with self._lock:
            clean = _clean_set_name(name or self.active_name())
            row = self.data["sets"].get(clean)
            if not isinstance(row, dict):
                return clean, []
            ids = self._filter_ids(row.get("ids") or [], valid_ids)
            if ids != row.get("ids"):
                row["ids"] = ids
                row["updated_at"] = _now()
                self._save()
            return clean, list(ids)

    def delete_set(self, name: str | None, valid_ids: set[str]) -> str:
        with self._lock:
            clean = _clean_set_name(name)
            self.data["sets"].pop(clean, None)
            if not self.data["sets"]:
                self.data["sets"]["PREP"] = self._new_set("PREP", [])
            if self.active_name() == clean:
                self.data["active_set"] = sorted(self.data["sets"])[0]
                self.get_active_ids(valid_ids)
            self._save()
            return self.active_name()

    def list_sets(self, valid_ids: set[str]) -> dict:
        with self._lock:
            active = self.active_name()
            rows = []
            changed = False
            for name, row in list(self.data["sets"].items()):
                if not isinstance(row, dict):
                    self.data["sets"][name] = self._new_set(name, [])
                    row = self.data["sets"][name]
                    changed = True
                ids = self._filter_ids(row.get("ids") or [], valid_ids)
                if ids != row.get("ids"):
                    row["ids"] = ids
                    row["updated_at"] = _now()
                    changed = True
                rows.append({
                    "name": row.get("name") or name,
                    "count": len(ids),
                    "ids": list(ids),
                    "updated_at": row.get("updated_at") or 0,
                })
            rows.sort(key=lambda r: (r["name"] != active, r["name"].lower()))
            if changed:
                self._save()
            return {"active_set": active, "sets": rows}


class DJServer(http.server.ThreadingHTTPServer):
    """Threading server with library state."""

    def __init__(self, addr, handler_cls, library: list[dict],
                 midi_bridge=None, midi_error: str | None = None):
        super().__init__(addr, handler_cls)
        self._library_lock = threading.RLock()
        self.midi_bridge = midi_bridge
        self.midi_error = midi_error
        self.prepare_ids: list[str] = []
        self.state = DJStateStore(DJ_STATE_PATH)
        self._install_library(library)
        self.prepare_ids = self.state.get_active_ids(set(self._by_id))

    def runtime_info(self) -> dict:
        if self.midi_bridge:
            return self.midi_bridge.runtime_info()
        return {
            "midi_ws_url": None,
            "native_midi_available": False,
            "native_midi_error": self.midi_error,
        }

    def _install_library(self, library: list[dict]) -> None:
        # main tracks indexed by id; public library strips filesystem-only fields
        self._by_id: dict[str, dict] = {t["id"]: t for t in library}
        self.library = [self._public_entry(t) for t in library]
        self._stem_by_id: dict[str, str] = {}
        for t in library:
            for name, path in (t.get("_stem_paths") or {}).items():
                sid = _track_id(path)
                self._stem_by_id[sid] = path

    @staticmethod
    def _public_entry(track: dict) -> dict:
        return {k: v for k, v in track.items() if not k.startswith("_")}

    def replace_library(self, rows: list[dict]) -> int:
        """Replace the served library without restarting the DJ deck."""
        library = build_library_json(rows)
        with self._library_lock:
            self._install_library(library)
            valid_ids = set(self._by_id)
            self.prepare_ids = self.state.get_active_ids(valid_ids)
            return len(self.library)

    def get_prepare_ids(self) -> list[str]:
        with self._library_lock:
            valid_ids = set(self._by_id)
            self.prepare_ids = self.state.get_active_ids(valid_ids)
            return list(self.prepare_ids)

    def set_prepare_ids(self, ids: list[str]) -> list[str]:
        with self._library_lock:
            valid_ids = set(self._by_id)
            self.prepare_ids = self.state.set_active_ids(ids, valid_ids)
            return list(self.prepare_ids)

    def get_sets(self) -> dict:
        with self._library_lock:
            return self.state.list_sets(set(self._by_id))

    def save_set(self, name: str | None, ids: list[str]) -> dict:
        with self._library_lock:
            row = self.state.save_set(name, ids, set(self._by_id))
            self.prepare_ids = list(row.get("ids") or [])
            return row

    def load_set(self, name: str | None) -> list[str]:
        with self._library_lock:
            self.prepare_ids = self.state.load_set(name, set(self._by_id))
            return list(self.prepare_ids)

    def delete_set(self, name: str | None) -> str:
        with self._library_lock:
            active = self.state.delete_set(name, set(self._by_id))
            self.prepare_ids = self.state.get_active_ids(set(self._by_id))
            return active

    def get_set_tracks(self, name: str | None) -> tuple[str, list[dict]]:
        with self._library_lock:
            set_name, ids = self.state.get_set_ids(name, set(self._by_id))
            return set_name, [self._by_id[tid] for tid in ids if tid in self._by_id]

    def get_track(self, track_id: str) -> Optional[dict]:
        with self._library_lock:
            if track_id in self._by_id:
                return self._by_id[track_id]
            # stem fallback
            path = self._stem_by_id.get(track_id)
        if path:
            return {"_path": path}
        return None

    def refresh_stems_for(self, track_id: str) -> None:
        """Re-scan disk for stems of a track and update library entry."""
        with self._library_lock:
            t = self._by_id.get(track_id)
            if not t:
                return
            stems = _detect_stems(t["_path"])
            if stems:
                t["stems"] = {n: u for n, (_, u) in stems.items()}
                t["_stem_paths"] = {n: p for n, (p, _u) in stems.items()}
                self._stem_by_id = {}
                for row in self._by_id.values():
                    for name, path in (row.get("_stem_paths") or {}).items():
                        sid = _track_id(path)
                        self._stem_by_id[sid] = path
                self.library = [self._public_entry(row) for row in self._by_id.values()]


def _track_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:12]


STEM_NAMES = ("vocals", "drums", "bass", "other")


def _detect_stems(track_path: str) -> dict | None:
    """If Demucs output exists for this track, return URL map."""
    p = Path(track_path)
    candidates = [
        p.parent / "_stems" / "htdemucs" / p.stem,
        p.parent / "stems" / p.stem,
    ]
    for c in candidates:
        if not c.is_dir():
            continue
        urls = {}
        for name in STEM_NAMES:
            for ext in (".wav", ".flac", ".mp3", ".m4a"):
                f = c / f"{name}{ext}"
                if f.is_file():
                    sid = _track_id(str(f))
                    urls[name] = (str(f), f"/audio?id={sid}")
                    break
        if len(urls) == len(STEM_NAMES):
            return urls
    return None


def build_library_json(rows: list[dict]) -> list[dict]:
    """Take rows like {path, title, artist, bpm, key, camelot} → public JSON."""
    out = []
    for r in rows:
        p = r.get("path") or r.get("file")
        if not p or not Path(p).is_file():
            continue
        tid = _track_id(p)
        entry = {
            "id": tid,
            "_path": p,
            "url": f"/audio?id={tid}",
            "title": r.get("title") or Path(p).stem,
            "artist": r.get("artist") or "",
            "bpm": r.get("bpm") or 0,
            "raw_bpm": r.get("raw_bpm") or r.get("bpm") or 0,
            "bpm_multiplier": r.get("bpm_multiplier") or 1,
            "key": r.get("key") or "",
            "camelot": r.get("camelot") or "",
            "key_confidence": r.get("key_confidence"),
            "duration": r.get("duration") or 0,
            "filename": Path(p).name,
            "shazam_url": r.get("shazam_url") or "",
            "genre": r.get("genre") or "",
            "energy": r.get("energy") or "",
            "tags": _normalize_tags(r.get("tags") or r.get("tag") or r.get("genre") or ""),
            "analysis_status": _analysis_status(r),
        }
        entry["ready_for_set"] = bool(entry["bpm"] and entry["camelot"] not in ("", "?"))
        stems = _detect_stems(p)
        if stems:
            entry["stems"] = {name: url for name, (_path, url) in stems.items()}
            entry["_stem_paths"] = {name: path for name, (path, _url) in stems.items()}
        out.append(entry)
    return out


def _normalize_tags(value) -> list[str]:
    if isinstance(value, list):
        raw = value
    else:
        raw = re.split(r"[,;/#]+", str(value or ""))
    tags = []
    seen = set()
    for tag in raw:
        text = str(tag).strip()
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            tags.append(text)
    return tags[:12]


def _analysis_status(row: dict) -> str:
    if row.get("bpm") and row.get("camelot") not in ("", None, "?"):
        return "ready"
    if row.get("bpm") or row.get("key") or row.get("camelot"):
        return "partial"
    return "missing"


class DJHandler(http.server.SimpleHTTPRequestHandler):
    """Static + JSON + Range-capable audio."""

    server: DJServer

    def log_message(self, fmt, *args):
        # quiet by default — can be redirected by caller
        pass

    # ----------------------------------------------------------- routes
    def do_GET(self) -> None:
        url = urllib.parse.urlparse(self.path)
        path = url.path

        if path in ("/", "/index.html"):
            return self._serve_static("index.html")
        if path == "/library.json":
            return self._serve_library()
        if path == "/prepare.json":
            return self._serve_prepare()
        if path == "/sets.json":
            return self._serve_sets()
        if path == "/export":
            qs = urllib.parse.parse_qs(url.query)
            return self._serve_export(
                qs.get("format", ["m3u"])[0],
                qs.get("set", [None])[0],
            )
        if path == "/runtime.json":
            return self._serve_runtime()
        if path == "/audio":
            qs = urllib.parse.parse_qs(url.query)
            return self._serve_audio(qs.get("id", [""])[0])
        if path == "/stems/status":
            qs = urllib.parse.parse_qs(url.query)
            return self._serve_stems_status(qs.get("id", [""])[0])
        # static files under /dj/*  — but we expose them at root
        return self._serve_static(path.lstrip("/"))

    def do_POST(self) -> None:
        if not self._same_origin_request():
            return self._json({"error": "cross-origin request blocked"}, 403)
        url = urllib.parse.urlparse(self.path)
        if url.path == "/stems":
            qs = urllib.parse.parse_qs(url.query)
            return self._serve_stems_start(qs.get("id", [""])[0])
        if url.path == "/prepare":
            return self._serve_prepare_update()
        if url.path == "/sets":
            return self._serve_sets_update()
        self.send_error(404)

    def do_HEAD(self) -> None:
        self.do_GET()

    # ----------------------------------------------------------- helpers
    def _serve_static(self, rel: str) -> None:
        rel = urllib.parse.unquote(rel)
        if "\x00" in rel:
            self.send_error(404, "not found")
            return
        root = DJ_DIR.resolve()
        candidate = (root / rel).resolve()
        if not candidate.is_relative_to(root):
            self.send_error(404, "not found")
            return
        if not candidate.is_file():
            self.send_error(404, f"not found: {rel}")
            return
        ctype, _ = mimetypes.guess_type(str(candidate))
        if ctype is None:
            if candidate.suffix == ".js":
                ctype = "application/javascript"
            else:
                ctype = "application/octet-stream"
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8"
                         if "javascript" in ctype or "css" in ctype or "html" in ctype
                         else ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if candidate.suffix == ".html":
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; "
                "img-src 'self' blob: data:",
            )
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(data)

    def _same_origin_request(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            referer = self.headers.get("Referer")
            if not referer:
                return True
            origin = referer
        try:
            parsed = urllib.parse.urlparse(origin)
        except ValueError:
            return False
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return False
        return parsed.netloc.lower() == (self.headers.get("Host") or "").lower()

    def _serve_library(self) -> None:
        with self.server._library_lock:
            rows = list(self.server.library)
        body = json.dumps(rows, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _serve_runtime(self) -> None:
        self._json(self.server.runtime_info())

    def _serve_prepare(self) -> None:
        self._json({
            "ids": self.server.get_prepare_ids(),
            "active_set": self.server.state.active_name(),
        })

    def _serve_prepare_update(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json({"error": "invalid content length"}, 400)
        if length > 1024 * 1024:
            return self._json({"error": "payload too large"}, 413)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._json({"error": "invalid json"}, 400)
        ids = payload.get("ids")
        if not isinstance(ids, list):
            return self._json({"error": "ids must be a list"}, 400)
        saved = self.server.set_prepare_ids(ids)
        return self._json({"ids": saved, "active_set": self.server.state.active_name()})

    def _serve_sets(self) -> None:
        self._json(self.server.get_sets())

    def _serve_sets_update(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json({"error": "invalid content length"}, 400)
        if length > 1024 * 1024:
            return self._json({"error": "payload too large"}, 413)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._json({"error": "invalid json"}, 400)
        action = payload.get("action") or "save"
        name = payload.get("name")
        if action == "save":
            ids = payload.get("ids")
            if not isinstance(ids, list):
                return self._json({"error": "ids must be a list"}, 400)
            self.server.save_set(name, ids)
        elif action == "load":
            self.server.load_set(name)
        elif action == "delete":
            self.server.delete_set(name)
        else:
            return self._json({"error": f"unknown action: {action}"}, 400)
        out = self.server.get_sets()
        out["ids"] = self.server.get_prepare_ids()
        return self._json(out)

    def _serve_export(self, fmt: str, set_name: str | None) -> None:
        fmt = (fmt or "m3u").lower()
        name, tracks = self.server.get_set_tracks(set_name)
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "prep"
        if fmt == "json":
            rows = []
            for t in tracks:
                rows.append({
                    "id": t.get("id"),
                    "path": t.get("_path"),
                    "title": t.get("title"),
                    "artist": t.get("artist"),
                    "bpm": t.get("bpm"),
                    "key": t.get("key"),
                    "camelot": t.get("camelot"),
                    "tags": t.get("tags") or [],
                    "energy": t.get("energy") or "",
                })
            body = json.dumps({
                "name": name,
                "count": len(rows),
                "tracks": rows,
            }, ensure_ascii=False, indent=2).encode("utf-8")
            ctype = "application/json; charset=utf-8"
            filename = f"{safe_name}.json"
        else:
            lines = ["#EXTM3U"]
            for t in tracks:
                title = f"{t.get('artist') or ''} - {t.get('title') or Path(t.get('_path', '')).stem}".strip(" -")
                duration = int(float(t.get("duration") or -1))
                lines.append(f"#EXTINF:{duration},{title}")
                lines.append(str(t.get("_path") or ""))
            body = ("\n".join(lines) + "\n").encode("utf-8")
            ctype = "audio/x-mpegurl; charset=utf-8"
            filename = f"{safe_name}.m3u"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_audio(self, track_id: str) -> None:
        track = self.server.get_track(track_id)
        if not track:
            self.send_error(404, "track id not found")
            return
        path = Path(track["_path"])
        if not path.is_file():
            self.send_error(404, "file missing on disk")
            return
        return self._send_with_range(path)

    def _json(self, obj, status=200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _serve_stems_start(self, track_id: str) -> None:
        track = self.server.get_track(track_id)
        if not track or "_path" not in track:
            return self._json({"error": "track not found"}, 404)
        with _STEM_JOBS_LOCK:
            existing = _STEM_JOBS.get(track_id)
            if existing and existing["status"] == "running":
                return self._json({"status": "running", "job": track_id})
            _STEM_JOBS[track_id] = {
                "status": "running", "error": None,
                "started": time.time(), "track_id": track_id,
            }
        # spawn worker
        threading.Thread(
            target=_run_demucs_job,
            args=(track_id, track["_path"], self.server),
            daemon=True,
        ).start()
        return self._json({"status": "running", "job": track_id})

    def _serve_stems_status(self, track_id: str) -> None:
        with _STEM_JOBS_LOCK:
            job = _STEM_JOBS.get(track_id)
        if not job:
            return self._json({"status": "idle"})
        out = {
            "status": job["status"],
            "elapsed": round(time.time() - job["started"], 1),
        }
        if job.get("error"): out["error"] = job["error"]
        if job["status"] == "done":
            t = self.server.get_track(track_id)
            if t and t.get("stems"): out["stems"] = t["stems"]
        return self._json(out)

    def _send_with_range(self, path: Path) -> None:
        size = path.stat().st_size
        ctype, _ = mimetypes.guess_type(str(path))
        ctype = ctype or "audio/mpeg"
        rng = self.headers.get("Range")
        start = 0
        end = size - 1
        partial = False
        if rng and rng.startswith("bytes="):
            try:
                spec = rng[6:].strip()
                s, e = spec.split("-", 1)
                if s.strip():
                    start = int(s)
                if e.strip():
                    end = int(e)
                if start < 0 or end >= size or start > end:
                    raise ValueError
                partial = True
            except (ValueError, AttributeError):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    return
                remaining -= len(chunk)


def _run_demucs_job(track_id: str, audio_path: str, server: "DJServer") -> None:
    if not DEMUCS_BIN.is_file():
        with _STEM_JOBS_LOCK:
            _STEM_JOBS[track_id]["status"] = "error"
            _STEM_JOBS[track_id]["error"] = "demucs binary not found"
        return
    src = Path(audio_path)
    out_dir = src.parent / "_stems"
    out_dir.mkdir(exist_ok=True)
    cmd = [str(DEMUCS_BIN), "-n", "htdemucs", "-o", str(out_dir), str(src)]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except Exception as e:
        with _STEM_JOBS_LOCK:
            _STEM_JOBS[track_id]["status"] = "error"
            _STEM_JOBS[track_id]["error"] = str(e)
        return
    if p.returncode != 0:
        with _STEM_JOBS_LOCK:
            _STEM_JOBS[track_id]["status"] = "error"
            _STEM_JOBS[track_id]["error"] = (p.stderr or "demucs failed")[-500:]
        return
    server.refresh_stems_for(track_id)
    with _STEM_JOBS_LOCK:
        _STEM_JOBS[track_id]["status"] = "done"


def _start_midi_bridge(host: str):
    if NativeMidiBridge is None:
        return None, "Native MIDI bridge module could not be imported"
    bridge = NativeMidiBridge(host=host)
    bridge.start()
    if bridge.available:
        return bridge, None
    error = bridge.error or "Native MIDI helper did not start"
    bridge.stop()
    return None, error


def start_server(library: list[dict], host: str = "127.0.0.1",
                 port: int = 8765) -> tuple[DJServer, threading.Thread]:
    midi_bridge, midi_error = _start_midi_bridge(host)
    try:
        server = DJServer(
            (host, port),
            DJHandler,
            build_library_json(library),
            midi_bridge=midi_bridge,
            midi_error=midi_error,
        )
    except Exception:
        if midi_bridge:
            midi_bridge.stop()
        raise
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, t


def stop_server(server: DJServer) -> None:
    try:
        if getattr(server, "midi_bridge", None):
            server.midi_bridge.stop()
        server.shutdown()
        server.server_close()
    except Exception:
        pass


if __name__ == "__main__":
    import argparse, signal, sys, time
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", help="JSON file s knihovnou tracků")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    rows: list[dict] = []
    if args.library and Path(args.library).is_file():
        rows = json.loads(Path(args.library).read_text())
    srv, _ = start_server(rows, port=args.port)
    print(f"DJ server běží na http://127.0.0.1:{args.port}", flush=True)
    print(f"  Tracků v knihovně: {len(srv.library)}", flush=True)
    signal.signal(signal.SIGINT, lambda *_: (stop_server(srv), sys.exit(0)))
    while True:
        time.sleep(60)
