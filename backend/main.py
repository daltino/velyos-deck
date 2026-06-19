#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import importlib.util
import json
import mimetypes
import os
import queue
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("SCDL_GUI_DATA_DIR", str(Path.home() / ".music-dl-gui"))).expanduser()
DB_PATH = DATA_DIR / "state.sqlite3"
LEGACY_CONFIG = Path.home() / ".music-dl-gui.json"
LEGACY_DJ_CACHE = Path.home() / ".music-dl-gui-dj-cache.json"
LEGACY_DJ_STATE = Path.home() / ".music-dl-gui-dj-state.json"
DJ_DIR = ROOT / "dj"
WEB_DIST = ROOT / "web" / "dist"
WEB_INDEX = WEB_DIST / "index.html"
AUDIO_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".opus", ".ogg"}
ENHANCE_TRACK_TIMEOUT = 600
CLUB_MASTER_MEASURE_TIMEOUT = 300
JOB_WATCHDOG_INTERVAL = 15
JOB_STALE_SECONDS = 120
API_TOKEN = os.environ.get("SCDL_GUI_API_TOKEN") or secrets.token_urlsafe(32)
SECRET_OPTION_KEYS = {"token", "authToken", "accessToken", "refreshToken", "clientSecret", "password"}
PROTECTED_ROUTE_PREFIXES = (
    "/api",
    "/audio",
    "/library.json",
    "/prepare",
    "/prepare.json",
    "/sets",
    "/sets.json",
    "/runtime.json",
    "/stems",
    "/export",
)


sys.path.insert(0, str(ROOT))
import dj_server  # noqa: E402 -- local DJ HTTP / MIDI helper (repo root)
from backend import dj_core  # noqa: E402 -- local-only core audio helpers

try:
    # Optional, gitignored, EXCLUDED FROM THE PUBLIC RELEASE. When absent the
    # download / online-discovery features degrade gracefully (UI hidden).
    import downloader_local  # noqa: E402
except Exception:
    downloader_local = None

DOWNLOADER_AVAILABLE = downloader_local is not None


class _LegacyShim:
    """Compatibility facade replacing the old monolithic app.py import.

    Local-only audio helpers come from backend.dj_core (always available).
    Streaming-download / online-discovery helpers come from the optional
    downloader_local module; when it is absent the related endpoints return
    empty/no-op results and the download UI is hidden.
    """
    dj_server = dj_server
    DEMUCS_BIN = dj_core.DEMUCS_BIN
    analyze_track = staticmethod(dj_core.analyze_track)
    stem_separate = staticmethod(dj_core.stem_separate)
    build_enhance_filter = staticmethod(dj_core.build_enhance_filter)
    _parse_loudnorm_json = staticmethod(dj_core._parse_loudnorm_json)
    find_audiosr = staticmethod(dj_core.find_audiosr)

    if downloader_local is not None:
        find_scdl = staticmethod(downloader_local.find_scdl)
        find_ytdlp = staticmethod(downloader_local.find_ytdlp)
        find_spotdl = staticmethod(downloader_local.find_spotdl)
        detect_source = staticmethod(downloader_local.detect_source)
        scdl_command = staticmethod(downloader_local.scdl_command)
        ytdlp_command = staticmethod(downloader_local.ytdlp_command)
        spotdl_command = staticmethod(downloader_local.spotdl_command)
        parse_progress = staticmethod(downloader_local.parse_progress)
        quality_finder = staticmethod(downloader_local.quality_finder)
        fetch_similar_tracks = staticmethod(downloader_local.fetch_similar_tracks)
    else:
        find_scdl = staticmethod(lambda: None)
        find_ytdlp = staticmethod(lambda: None)
        find_spotdl = staticmethod(lambda: None)
        detect_source = staticmethod(lambda line: "skip")
        scdl_command = staticmethod(lambda *a, **k: None)
        ytdlp_command = staticmethod(lambda *a, **k: None)
        spotdl_command = staticmethod(lambda *a, **k: None)
        parse_progress = staticmethod(lambda line: None)
        quality_finder = staticmethod(lambda query: [])
        fetch_similar_tracks = staticmethod(lambda seed, limit=15: [])


legacy = _LegacyShim()


def now() -> int:
    return int(time.time())


def json_load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return fallback


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def normalize_quality(value: Any) -> str:
    text = str(value or "").strip()
    mapping = {
        "Top (lossless když možno)": "best",
        "MP3 320 kbps": "mp3-320",
        "FLAC": "flac",
        "Opus (menší)": "opus",
    }
    return mapping.get(text, text if text in {"best", "mp3-320", "flac", "opus"} else "best")


def clean_set_name(name: str | None) -> str:
    import re

    text = re.sub(r"\s+", " ", str(name or "")).strip()
    return text[:80] or "PREP"


def clean_job_name(name: Any) -> str:
    import re

    return re.sub(r"\s+", " ", str(name or "")).strip()[:120]


def redact_text(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text = value
    patterns = [
        (r"(--(?:auth-token|token|password|api-key)\s+)(\S+)", r"\1[REDACTED]"),
        (r"((?:token|access_token|auth|password|client_secret)=)([^&\s]+)", r"\1[REDACTED]"),
        (r"(Authorization:\s*(?:Bearer\s+)?)(\S+)", r"\1[REDACTED]"),
    ]
    import re

    for pattern, repl in patterns:
        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    return text


def redact_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if key_text in SECRET_OPTION_KEYS or any(part in key_text.lower() for part in ("token", "secret", "password")):
                out[key_text] = "[REDACTED]" if item else ""
            else:
                out[key_text] = redact_secrets(item)
        return out
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    return redact_text(value)


def public_settings(settings: dict[str, Any]) -> dict[str, Any]:
    out = dict(settings)
    options = dict(out.get("options") or {})
    configured: dict[str, bool] = {}
    for key in list(options):
        if key in SECRET_OPTION_KEYS or any(part in key.lower() for part in ("token", "secret", "password")):
            configured[key] = bool(options.get(key))
            options[key] = ""
    if configured:
        options["_configured"] = configured
    out["options"] = options
    return out


def track_id_for_path(path: str) -> str:
    import hashlib

    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:12]


class StateStore:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self.lock = threading.RLock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._import_legacy_once()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def connection(self):
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self.connection() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tracks (
                  id TEXT PRIMARY KEY,
                  path TEXT UNIQUE NOT NULL,
                  title TEXT NOT NULL DEFAULT '',
                  artist TEXT NOT NULL DEFAULT '',
                  duration REAL NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS track_meta (
                  track_id TEXT PRIMARY KEY,
                  bpm REAL,
                  raw_bpm REAL,
                  bpm_multiplier REAL,
                  key TEXT,
                  camelot TEXT,
                  key_confidence REAL,
                  genre TEXT,
                  tags TEXT,
                  energy TEXT,
                  shazam_url TEXT,
                  source TEXT,
                  updated_at INTEGER NOT NULL,
                  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS sets (
                  name TEXT PRIMARY KEY,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS set_tracks (
                  set_name TEXT NOT NULL,
                  track_id TEXT NOT NULL,
                  position INTEGER NOT NULL,
                  PRIMARY KEY(set_name, track_id),
                  FOREIGN KEY(set_name) REFERENCES sets(name) ON DELETE CASCADE,
                  FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS jobs (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL DEFAULT '',
                  kind TEXT NOT NULL,
                  status TEXT NOT NULL,
                  progress REAL NOT NULL DEFAULT 0,
                  message TEXT NOT NULL DEFAULT '',
                  payload TEXT NOT NULL DEFAULT '{}',
                  result TEXT NOT NULL DEFAULT '{}',
                  error TEXT,
                  repeated_from TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                """
            )
            cols = {row["name"] for row in db.execute("PRAGMA table_info(jobs)").fetchall()}
            if "name" not in cols:
                db.execute("ALTER TABLE jobs ADD COLUMN name TEXT NOT NULL DEFAULT ''")
            if "repeated_from" not in cols:
                db.execute("ALTER TABLE jobs ADD COLUMN repeated_from TEXT")

    def _get_setting_raw(self, key: str) -> Any | None:
        with self.connection() as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return row["value"]

    def _import_legacy_once(self) -> None:
        with self.lock, self.connection() as db:
            row = db.execute("SELECT value FROM settings WHERE key='migration.legacy_imported'").fetchone()
            if row:
                return
            cfg = json_load(LEGACY_CONFIG, {})
            settings = {
                "destination": cfg.get("dest") or str(Path.home() / "Music" / "Downloads"),
                "quality": normalize_quality(cfg.get("quality") or "best"),
                "soundcloudMode": cfg.get("sc_mode", 0),
                "enhanceMode": cfg.get("enhance_mode") or "manual",
                "enhanceAudioSR": bool(cfg.get("enhance_audiosr", False)),
                "topLimit": int(cfg.get("top_limit") or 20),
                "options": cfg.get("opts") or {},
                "ui": {"language": "cs", "density": "dj"},
            }
            self.set_settings(settings, db=db)

            cache = json_load(LEGACY_DJ_CACHE, {})
            for entry in (cache.get("tracks") or {}).values():
                if not isinstance(entry, dict):
                    continue
                path = entry.get("last_path")
                if path and Path(path).is_file():
                    self.upsert_track({"path": path, **entry}, db=db)

            state = json_load(LEGACY_DJ_STATE, {})
            sets = state.get("sets") if isinstance(state, dict) else {}
            if isinstance(sets, dict):
                for name, row in sets.items():
                    ids = row.get("ids") if isinstance(row, dict) else []
                    self.save_set(name, ids if isinstance(ids, list) else [], db=db)
            if not db.execute("SELECT 1 FROM sets WHERE name='PREP'").fetchone():
                ts = now()
                db.execute("INSERT INTO sets(name, created_at, updated_at) VALUES(?,?,?)", ("PREP", ts, ts))
            db.execute(
                "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)",
                ("migration.legacy_imported", "true", now()),
            )

    def get_settings(self) -> dict[str, Any]:
        with self.connection() as db:
            rows = db.execute("SELECT key,value FROM settings").fetchall()
        out: dict[str, Any] = {}
        for row in rows:
            if str(row["key"]).startswith("migration."):
                continue
            try:
                out[row["key"]] = json.loads(row["value"])
            except json.JSONDecodeError:
                out[row["key"]] = row["value"]
        defaults = {
            "destination": str(Path.home() / "Music" / "Downloads"),
            "quality": "best",
            "soundcloudMode": 0,
            "enhanceMode": "manual",
            "enhanceAudioSR": False,
            "topLimit": 20,
            "options": {},
            "ui": {"language": "cs", "density": "dj"},
        }
        merged = {**defaults, **out}
        merged["quality"] = normalize_quality(merged.get("quality"))
        return merged

    def set_settings(self, settings: dict[str, Any], db: sqlite3.Connection | None = None) -> dict[str, Any]:
        own = db is None
        db = db or self.connect()
        try:
            settings = dict(settings)
            existing_settings = self.get_settings() if own else {}
            if isinstance(settings.get("options"), dict):
                incoming_options = dict(settings["options"])
                incoming_options.pop("_configured", None)
                existing_options = (existing_settings.get("options") or {}) if own else {}
                for key in list(incoming_options):
                    if key in SECRET_OPTION_KEYS or any(part in key.lower() for part in ("token", "secret", "password")):
                        if incoming_options.get(key) in {"", None} and existing_options.get(key):
                            incoming_options.pop(key)
                settings["options"] = {**existing_options, **incoming_options} if own else incoming_options
            merged = {**existing_settings, **settings} if own else settings
            if isinstance(merged.get("options"), dict):
                merged["options"] = {k: v for k, v in dict(merged["options"]).items() if k != "_configured"}
            if "quality" in merged:
                merged["quality"] = normalize_quality(merged["quality"])
            ts = now()
            for key, value in merged.items():
                db.execute(
                    "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)",
                    (key, json_dumps(value), ts),
                )
            if own:
                db.commit()
            return self.get_settings() if own else merged
        finally:
            if own:
                db.close()

    def upsert_track(self, data: dict[str, Any], db: sqlite3.Connection | None = None) -> dict[str, Any]:
        path = str(data.get("path") or data.get("file") or "").strip()
        if not path:
            raise ValueError("path is required")
        tid = data.get("id") or track_id_for_path(path)
        title = data.get("title") or Path(path).stem
        artist = data.get("artist") or ""
        ts = now()
        own = db is None
        db = db or self.connect()
        try:
            db.execute(
                """
                INSERT INTO tracks(id,path,title,artist,duration,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(path) DO UPDATE SET
                  title=excluded.title, artist=excluded.artist,
                  duration=excluded.duration, updated_at=excluded.updated_at
                """,
                (tid, path, title, artist, float(data.get("duration") or 0), ts, ts),
            )
            db.execute(
                """
                INSERT INTO track_meta(track_id,bpm,raw_bpm,bpm_multiplier,key,camelot,
                  key_confidence,genre,tags,energy,shazam_url,source,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(track_id) DO UPDATE SET
                  bpm=excluded.bpm, raw_bpm=excluded.raw_bpm,
                  bpm_multiplier=excluded.bpm_multiplier, key=excluded.key,
                  camelot=excluded.camelot, key_confidence=excluded.key_confidence,
                  genre=excluded.genre, tags=excluded.tags, energy=excluded.energy,
                  shazam_url=excluded.shazam_url, source=excluded.source,
                  updated_at=excluded.updated_at
                """,
                (
                    tid,
                    data.get("bpm"),
                    data.get("raw_bpm"),
                    data.get("bpm_multiplier"),
                    data.get("key"),
                    data.get("camelot"),
                    data.get("key_confidence"),
                    data.get("genre"),
                    json_dumps(data.get("tags") or []),
                    data.get("energy"),
                    data.get("shazam_url") or data.get("url"),
                    data.get("source") or "manual",
                    ts,
                ),
            )
            if own:
                db.commit()
            return self.get_track(tid, db=db)
        finally:
            if own:
                db.close()

    def get_track(self, tid: str, db: sqlite3.Connection | None = None) -> dict[str, Any]:
        own = db is None
        db = db or self.connect()
        try:
            row = db.execute(
                """
                SELECT t.*, m.bpm, m.raw_bpm, m.bpm_multiplier, m.key, m.camelot,
                       m.key_confidence, m.genre, m.tags, m.energy, m.shazam_url, m.source
                FROM tracks t LEFT JOIN track_meta m ON m.track_id=t.id
                WHERE t.id=?
                """,
                (tid,),
            ).fetchone()
            if not row:
                raise KeyError(tid)
            return row_to_track(row)
        finally:
            if own:
                db.close()

    def list_tracks(self, q: str = "", limit: int = 500) -> list[dict[str, Any]]:
        sql = """
            SELECT t.*, m.bpm, m.raw_bpm, m.bpm_multiplier, m.key, m.camelot,
                   m.key_confidence, m.genre, m.tags, m.energy, m.shazam_url, m.source
            FROM tracks t LEFT JOIN track_meta m ON m.track_id=t.id
        """
        args: list[Any] = []
        if q:
            sql += " WHERE lower(t.title || ' ' || t.artist || ' ' || t.path) LIKE ?"
            args.append(f"%{q.lower()}%")
        sql += " ORDER BY t.updated_at DESC LIMIT ?"
        args.append(limit)
        with self.connection() as db:
            return [row_to_track(r) for r in db.execute(sql, args).fetchall()]

    def delete_track(self, tid: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM tracks WHERE id=?", (tid,))

    def save_set(self, name: str | None, ids: list[str], db: sqlite3.Connection | None = None) -> dict[str, Any]:
        name = clean_set_name(name)
        own = db is None
        db = db or self.connect()
        try:
            ts = now()
            db.execute(
                "INSERT INTO sets(name,created_at,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at",
                (name, ts, ts),
            )
            db.execute("DELETE FROM set_tracks WHERE set_name=?", (name,))
            valid = {
                r["id"]
                for r in db.execute(
                    "SELECT id FROM tracks WHERE id IN (%s)" % ",".join("?" for _ in ids),
                    ids,
                ).fetchall()
            } if ids else set()
            for pos, tid in enumerate([tid for tid in ids if tid in valid]):
                db.execute(
                    "INSERT OR REPLACE INTO set_tracks(set_name,track_id,position) VALUES(?,?,?)",
                    (name, tid, pos),
                )
            db.execute(
                "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)",
                ("active_set", json_dumps(name), ts),
            )
            if own:
                db.commit()
            return self.get_sets(db=db)
        finally:
            if own:
                db.close()

    def get_sets(self, db: sqlite3.Connection | None = None) -> dict[str, Any]:
        own = db is None
        db = db or self.connect()
        try:
            active = self._get_setting_raw("active_set") or "PREP"
            rows = db.execute(
                """
                SELECT s.name, s.updated_at, count(st.track_id) AS count
                FROM sets s LEFT JOIN set_tracks st ON st.set_name=s.name
                GROUP BY s.name, s.updated_at ORDER BY s.name != ?, lower(s.name)
                """,
                (active,),
            ).fetchall()
            sets = []
            for r in rows:
                ids = [
                    x["track_id"]
                    for x in db.execute(
                        "SELECT track_id FROM set_tracks WHERE set_name=? ORDER BY position",
                        (r["name"],),
                    ).fetchall()
                ]
                sets.append({"name": r["name"], "count": r["count"], "ids": ids, "updated_at": r["updated_at"]})
            return {"active_set": active, "sets": sets}
        finally:
            if own:
                db.close()

    def load_set(self, name: str | None) -> dict[str, Any]:
        name = clean_set_name(name)
        with self.connection() as db:
            if not db.execute("SELECT 1 FROM sets WHERE name=?", (name,)).fetchone():
                ts = now()
                db.execute("INSERT INTO sets(name,created_at,updated_at) VALUES(?,?,?)", (name, ts, ts))
            db.execute(
                "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)",
                ("active_set", json_dumps(name), now()),
            )
        return self.get_sets()

    def delete_set(self, name: str | None) -> dict[str, Any]:
        name = clean_set_name(name)
        with self.connection() as db:
            db.execute("DELETE FROM sets WHERE name=?", (name,))
            if not db.execute("SELECT 1 FROM sets").fetchone():
                ts = now()
                db.execute("INSERT INTO sets(name,created_at,updated_at) VALUES(?,?,?)", ("PREP", ts, ts))
        return self.get_sets()

    def set_tracks(self, name: str | None) -> tuple[str, list[dict[str, Any]]]:
        name = clean_set_name(name or self._get_setting_raw("active_set") or "PREP")
        with self.connection() as db:
            rows = db.execute(
                """
                SELECT t.*, m.bpm, m.raw_bpm, m.bpm_multiplier, m.key, m.camelot,
                       m.key_confidence, m.genre, m.tags, m.energy, m.shazam_url, m.source
                FROM set_tracks st
                JOIN tracks t ON t.id=st.track_id
                LEFT JOIN track_meta m ON m.track_id=t.id
                WHERE st.set_name=?
                ORDER BY st.position
                """,
                (name,),
            ).fetchall()
            return name, [row_to_track(r) for r in rows]

    def create_job(self, kind: str, payload: dict[str, Any], name: str = "", repeated_from: str | None = None) -> str:
        jid = uuid.uuid4().hex[:12]
        ts = now()
        stored_payload = redact_secrets(payload)
        with self.connection() as db:
            db.execute(
                "INSERT INTO jobs(id,name,kind,status,progress,message,payload,result,repeated_from,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (jid, clean_job_name(name), kind, "queued", 0, "Čeká ve frontě", json_dumps(stored_payload), "{}", repeated_from, ts, ts),
            )
        return jid

    def update_job(self, jid: str, **fields: Any) -> None:
        allowed = {"name", "status", "progress", "message", "result", "error"}
        pairs = []
        args = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            pairs.append(f"{key}=?")
            if key == "result" and not isinstance(value, str):
                args.append(json_dumps(redact_secrets(value)))
            elif key == "name":
                args.append(clean_job_name(value))
            elif key in {"message", "error"}:
                args.append(redact_text(value))
            else:
                args.append(value)
        if not pairs:
            return
        pairs.append("updated_at=?")
        args.append(now())
        args.append(jid)
        with self.connection() as db:
            db.execute(f"UPDATE jobs SET {','.join(pairs)} WHERE id=?", args)

    def rename_job(self, jid: str, name: str) -> dict[str, Any]:
        self.update_job(jid, name=clean_job_name(name))
        return self.get_job(jid)

    def get_job(self, jid: str) -> dict[str, Any]:
        with self.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
        if not row:
            raise KeyError(jid)
        return row_to_job(row)

    def list_jobs(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection() as db:
            rows = db.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [row_to_job(r) for r in rows]

    def mark_interrupted_jobs(self) -> int:
        message = "Backend byl restartován během jobu"
        ts = now()
        with self.connection() as db:
            cur = db.execute(
                """
                UPDATE jobs
                SET status='error', message=?, error=?, updated_at=?
                WHERE status IN ('queued', 'running')
                """,
                (message, message, ts),
            )
            return cur.rowcount or 0


def row_to_track(row: sqlite3.Row) -> dict[str, Any]:
    tags = row["tags"] or "[]"
    try:
        parsed_tags = json.loads(tags)
    except json.JSONDecodeError:
        parsed_tags = []
    return {
        "id": row["id"],
        "path": row["path"],
        "title": row["title"] or Path(row["path"]).stem,
        "artist": row["artist"] or "",
        "duration": row["duration"] or 0,
        "bpm": row["bpm"] or 0,
        "raw_bpm": row["raw_bpm"] or row["bpm"] or 0,
        "bpm_multiplier": row["bpm_multiplier"] or 1,
        "key": row["key"] or "",
        "camelot": row["camelot"] or "",
        "key_confidence": row["key_confidence"],
        "genre": row["genre"] or "",
        "tags": parsed_tags if isinstance(parsed_tags, list) else [],
        "energy": row["energy"] or "",
        "shazam_url": row["shazam_url"] or "",
        "source": row["source"] or "",
        "updated_at": row["updated_at"],
    }


def row_to_job(row: sqlite3.Row) -> dict[str, Any]:
    def parse(value: str, fallback: Any) -> Any:
        try:
            return json.loads(value)
        except Exception:
            return fallback

    return {
        "id": row["id"],
        "name": row["name"] or "",
        "kind": row["kind"],
        "status": row["status"],
        "progress": row["progress"],
        "message": row["message"],
        "payload": parse(row["payload"], {}),
        "result": parse(row["result"], {}),
        "error": row["error"],
        "repeated_from": row["repeated_from"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class EventBus:
    def __init__(self):
        self.subscribers: dict[str, list[queue.Queue]] = {}
        self.lock = threading.RLock()

    def publish(self, jid: str, event: dict[str, Any]) -> None:
        with self.lock:
            subscribers = list(self.subscribers.get(jid, []))
        for sub in subscribers:
            sub.put(event)

    def subscribe(self, jid: str):
        q: queue.Queue = queue.Queue()
        with self.lock:
            self.subscribers.setdefault(jid, []).append(q)
        try:
            yield q
        finally:
            with self.lock:
                self.subscribers.get(jid, []).remove(q)


class JobCancelled(RuntimeError):
    pass


class JobStepTimeout(RuntimeError):
    pass


@dataclass
class JobRuntime:
    cancel_requested: bool = False
    process: Any | None = None
    track: str | None = None
    step: str | None = None
    step_started_at: float = 0.0
    step_timeout: int = 0
    timed_out: bool = False


@dataclass
class JobManager:
    state: StateStore
    bus: EventBus
    threads: dict[str, threading.Thread] = field(default_factory=dict)
    runtime: dict[str, JobRuntime] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)
    watchdog_thread: threading.Thread | None = None
    watchdog_stop: threading.Event = field(default_factory=threading.Event)

    def start(
        self,
        kind: str,
        payload: dict[str, Any],
        worker: Callable[[str, dict[str, Any], "JobManager"], None],
        *,
        name: str = "",
        repeated_from: str | None = None,
    ) -> str:
        jid = self.state.create_job(kind, payload, name=name, repeated_from=repeated_from)
        t = threading.Thread(target=self._run, args=(jid, payload, worker), daemon=True)
        with self.lock:
            self.runtime[jid] = JobRuntime()
            self.threads[jid] = t
        t.start()
        return jid

    def _run(self, jid: str, payload: dict[str, Any], worker: Callable[[str, dict[str, Any], "JobManager"], None]) -> None:
        if self.is_cancelled(jid):
            self.try_update(jid, status="cancelled", message="Zrušeno")
            return
        self.try_update(jid, status="running", progress=1, message="Spuštěno")
        try:
            worker(jid, payload, self)
            job = self.state.get_job(jid)
            if job["status"] == "running":
                self.try_update(jid, status="done", progress=100, message="Hotovo")
        except JobCancelled:
            self.try_update(jid, status="cancelled", message="Zrušeno")
        except Exception as exc:
            try:
                job = self.state.get_job(jid)
                if job["status"] != "cancelled":
                    self.try_update(jid, status="error", error=str(exc), message=str(exc))
            except Exception:
                self.try_update(jid, status="error", error=str(exc), message=str(exc))
        finally:
            with self.lock:
                self.runtime.pop(jid, None)

    def update(self, jid: str, **fields: Any) -> None:
        last_exc: Exception | None = None
        for attempt in range(2):
            try:
                self.state.update_job(jid, **fields)
                event = {"job": self.state.get_job(jid)}
                self.bus.publish(jid, event)
                return
            except Exception as exc:
                last_exc = exc
                print(f"Job {jid} update failed: {exc}", file=sys.stderr)
                if attempt == 0:
                    time.sleep(0.2)
        assert last_exc is not None
        raise last_exc

    def try_update(self, jid: str, **fields: Any) -> bool:
        try:
            self.update(jid, **fields)
            return True
        except Exception as exc:
            print(f"Job {jid} update finally failed: {exc}", file=sys.stderr)
        return False

    def log(self, jid: str, line: str, progress: float | None = None) -> None:
        safe_line = str(redact_text(line))
        fields: dict[str, Any] = {"message": safe_line[-500:]}
        if progress is not None:
            fields["progress"] = progress
        try:
            self.state.update_job(jid, **fields)
            self.bus.publish(jid, {"log": safe_line, "job": self.state.get_job(jid)})
        except Exception as exc:
            print(f"Job {jid} log failed: {exc}; line={safe_line[-500:]}", file=sys.stderr)

    def begin_step(self, jid: str, track: str, step: str, timeout: int = 0) -> None:
        with self.lock:
            rt = self.runtime.setdefault(jid, JobRuntime())
            rt.track = track
            rt.step = step
            rt.step_started_at = time.time()
            rt.step_timeout = timeout
            rt.timed_out = False

    def set_process(self, jid: str, proc: Any | None) -> None:
        with self.lock:
            rt = self.runtime.setdefault(jid, JobRuntime())
            rt.process = proc

    def clear_step(self, jid: str) -> None:
        with self.lock:
            rt = self.runtime.get(jid)
            if rt:
                rt.process = None
                rt.track = None
                rt.step = None
                rt.step_started_at = 0.0
                rt.step_timeout = 0
                rt.timed_out = False

    def is_cancelled(self, jid: str) -> bool:
        with self.lock:
            return bool(self.runtime.get(jid, JobRuntime()).cancel_requested)

    def check_cancelled(self, jid: str) -> None:
        if self.is_cancelled(jid):
            raise JobCancelled("Job byl zrušen")

    def cancel(self, jid: str) -> dict[str, Any]:
        job = self.state.get_job(jid)
        if job["status"] in {"done", "error", "cancelled"}:
            return job
        proc = None
        with self.lock:
            rt = self.runtime.setdefault(jid, JobRuntime())
            rt.cancel_requested = True
            proc = rt.process
        self.log(jid, "Cancel requested\n")
        if proc is not None:
            self._stop_process(jid, proc, "cancel")
        self.try_update(jid, status="cancelled", message="Zrušeno uživatelem")
        return self.state.get_job(jid)

    def _stop_process(self, jid: str, proc: Any, reason: str) -> None:
        if proc.poll() is not None:
            return
        self.log(jid, f"Ukončuji subprocess ({reason})\n")
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=5)
            except Exception as exc:
                self.log(jid, f"!! Subprocess kill selhal: {exc}\n")

    def step_timed_out(self, jid: str) -> bool:
        with self.lock:
            return bool(self.runtime.get(jid, JobRuntime()).timed_out)

    def start_watchdog(self) -> None:
        if self.watchdog_thread and self.watchdog_thread.is_alive():
            return
        self.watchdog_stop.clear()
        self.watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True)
        self.watchdog_thread.start()

    def stop_watchdog(self) -> None:
        self.watchdog_stop.set()
        if self.watchdog_thread and self.watchdog_thread.is_alive():
            self.watchdog_thread.join(timeout=2)

    def _watchdog_loop(self) -> None:
        while not self.watchdog_stop.wait(JOB_WATCHDOG_INTERVAL):
            try:
                self.check_stale_jobs()
            except Exception as exc:
                print(f"Job watchdog failed: {exc}", file=sys.stderr)

    def check_stale_jobs(self) -> None:
        ts = now()
        active: dict[str, JobRuntime]
        with self.lock:
            active = {jid: rt for jid, rt in self.runtime.items()}
        for jid, rt in active.items():
            if rt.process and rt.step_started_at and rt.step_timeout:
                elapsed = time.time() - rt.step_started_at
                if elapsed > rt.step_timeout and rt.process.poll() is None:
                    with self.lock:
                        current = self.runtime.get(jid)
                        if current:
                            current.timed_out = True
                    self.log(jid, f"!! Timeout po {int(rt.step_timeout // 60)} minutách: {rt.step or 'krok'}\n")
                    self._stop_process(jid, rt.process, "watchdog timeout")
        for job in self.state.list_jobs(limit=100):
            if job["status"] not in {"queued", "running"}:
                continue
            if job["id"] in active:
                continue
            if ts - int(job.get("updated_at") or 0) >= JOB_STALE_SECONDS:
                self.try_update(
                    job["id"],
                    status="error",
                    error="Job zůstal bez běžícího workeru",
                    message="Job zůstal bez běžícího workeru",
                )


state = StateStore()
bus = EventBus()
jobs = JobManager(state, bus)
MIDI_BRIDGE: Any = None
MIDI_ERROR: str | None = None


def start_midi_bridge() -> None:
    global MIDI_BRIDGE, MIDI_ERROR
    try:
        if getattr(legacy.dj_server, "NativeMidiBridge", None) is None:
            MIDI_ERROR = "Native MIDI bridge module could not be imported"
            return
        bridge = legacy.dj_server.NativeMidiBridge(host="127.0.0.1")
        bridge.start()
        if bridge.available:
            MIDI_BRIDGE = bridge
            MIDI_ERROR = None
        else:
            MIDI_ERROR = bridge.error or "Native MIDI helper did not start"
            bridge.stop()
    except Exception as exc:
        MIDI_ERROR = str(exc)


def stop_midi_bridge() -> None:
    if MIDI_BRIDGE:
        MIDI_BRIDGE.stop()


@asynccontextmanager
async def lifespan(_: FastAPI):
    interrupted = state.mark_interrupted_jobs()
    if interrupted:
        print(f"Marked {interrupted} interrupted jobs as error", file=sys.stderr)
    start_midi_bridge()
    jobs.start_watchdog()
    try:
        yield
    finally:
        jobs.stop_watchdog()
        stop_midi_bridge()


app = FastAPI(title="SCDL GUI DJ OS", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1", "http://localhost"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


def request_is_loopback(request: Request) -> bool:
    hosts = {
        request.client.host if request.client else "",
        urllib.parse.urlparse(f"//{request.headers.get('host', '')}").hostname or "",
    }
    return all(host in {"", "127.0.0.1", "::1", "localhost"} for host in hosts)


def protected_path(path: str) -> bool:
    if path == "/api/client-config":
        return False
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in PROTECTED_ROUTE_PREFIXES)


@app.middleware("http")
async def same_origin_guard(request: Request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin") or request.headers.get("referer")
        if origin:
            parsed = urllib.parse.urlparse(origin)
            host = urllib.parse.urlparse(f"//{request.headers.get('host', '')}")
            same_host = parsed.netloc.lower() == request.headers.get("host", "").lower()
            local_dev = parsed.hostname in {"127.0.0.1", "localhost"} and host.hostname in {"127.0.0.1", "localhost"}
            if parsed.netloc and not same_host and not local_dev:
                return JSONResponse({"error": "cross-origin request blocked"}, status_code=403)
    path = request.url.path
    if path == "/api/client-config":
        if not request_is_loopback(request):
            return JSONResponse({"error": "client config is loopback-only"}, status_code=403)
    elif protected_path(path):
        supplied = request.headers.get("x-scdl-gui-token") or request.query_params.get("_scdl_token") or ""
        if not secrets.compare_digest(supplied, API_TOKEN):
            return JSONResponse({"error": "missing or invalid local API token"}, status_code=401)
    return await call_next(request)


class SettingsPayload(BaseModel):
    destination: str | None = None
    quality: str | None = None
    soundcloudMode: int | None = None
    enhanceMode: str | None = None
    enhanceAudioSR: bool | None = None
    topLimit: int | None = None
    options: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None


class DownloadPayload(BaseModel):
    jobName: str | None = None
    items: list[str] = Field(default_factory=list)
    destination: str | None = None
    quality: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)


class EnhancePayload(BaseModel):
    jobName: str | None = None
    trackIds: list[str] = Field(default_factory=list)
    paths: list[str] = Field(default_factory=list)
    folders: list[str] = Field(default_factory=list)
    recursive: bool = True
    mode: str = "manual"
    options: dict[str, Any] = Field(default_factory=dict)


class QualityPayload(BaseModel):
    jobName: str | None = None
    query: str


class SimilarPayload(BaseModel):
    jobName: str | None = None
    seed: str
    limit: int = 20


class TrackPayload(BaseModel):
    path: str
    title: str | None = None
    artist: str | None = None
    bpm: float | None = None
    key: str | None = None
    camelot: str | None = None
    genre: str | None = None
    tags: list[str] = Field(default_factory=list)


class SetPayload(BaseModel):
    name: str = "PREP"
    ids: list[str] = Field(default_factory=list)


class DialogPayload(BaseModel):
    initialDir: str | None = None
    multiple: bool = True
    audioOnly: bool = True


class JobNamePayload(BaseModel):
    name: str = ""


class ImportTracksPayload(BaseModel):
    paths: list[str] = Field(default_factory=list)
    folders: list[str] = Field(default_factory=list)
    recursive: bool = True


def tool_status() -> dict[str, bool]:
    return {
        "scdl": bool(legacy.find_scdl()),
        "yt-dlp": bool(legacy.find_ytdlp()),
        "spotdl": bool(legacy.find_spotdl()),
        "audiosr": bool(legacy.find_audiosr()),
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "demucs": bool(Path(getattr(legacy, "DEMUCS_BIN", "")).is_file()),
    }


def live_rows() -> list[dict[str, Any]]:
    rows = []
    for t in state.list_tracks(limit=5000):
        rows.append({**t, "file": t["path"]})
    return legacy.dj_server.build_library_json(rows) if getattr(legacy, "dj_server", None) else rows


def job_response(jid: str) -> dict[str, str]:
    return {"id": jid, "url": f"/api/jobs/{jid}", "events": f"/api/jobs/{jid}/events"}


def model_data(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_none=True)  # type: ignore[attr-defined]
    return model.dict(exclude_none=True)


def split_job_name(payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    data = dict(payload)
    return clean_job_name(data.pop("jobName", "")), data


def is_audio_path(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in AUDIO_EXTS


def expand_audio_inputs(
    *,
    paths: Iterable[str] = (),
    folders: Iterable[str] = (),
    recursive: bool = True,
) -> tuple[list[Path], list[str]]:
    out: list[Path] = []
    skipped: list[str] = []
    seen: set[str] = set()

    def add_file(path: Path) -> None:
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            skipped.append(str(path))
            return
        try:
            ensure_allowed_library_path(resolved)
        except HTTPException:
            skipped.append(str(resolved))
            return
        key = str(resolved)
        if key in seen:
            return
        if is_audio_path(resolved):
            seen.add(key)
            out.append(resolved)
        else:
            skipped.append(key)

    def add_folder(path: Path) -> None:
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            skipped.append(str(path))
            return
        try:
            ensure_allowed_library_path(resolved)
        except HTTPException:
            skipped.append(str(resolved))
            return
        if not resolved.is_dir():
            skipped.append(str(resolved))
            return
        iterator = resolved.rglob("*") if recursive else resolved.iterdir()
        for child in sorted(iterator):
            if child.is_file() and child.suffix.lower() in AUDIO_EXTS:
                add_file(child)

    for raw in paths:
        if not str(raw).strip():
            continue
        p = Path(str(raw).strip())
        if p.expanduser().is_dir():
            add_folder(p)
        else:
            add_file(p)
    for raw in folders:
        if str(raw).strip():
            add_folder(Path(str(raw).strip()))
    return out, skipped


def existing_dialog_dir(raw: str | None) -> Path:
    candidates: list[tuple[Path, bool]] = []
    if raw:
        candidates.append((Path(raw).expanduser(), True))
    candidates.extend([(Path.home() / "Music", False), (Path.home(), False)])
    for candidate in candidates:
        try:
            path, from_user = candidate
            current = path if path.is_dir() else path.parent
            while current and not current.exists():
                if current.parent == current:
                    break
                current = current.parent
            if from_user and current == Path("/"):
                continue
            if current and current.is_dir():
                return current.resolve()
        except OSError:
            continue
    return Path("/")


def run_finder_dialog(kind: str, payload: DialogPayload) -> list[str]:
    if sys.platform != "darwin":
        raise RuntimeError("Finder dialog is available only on macOS")
    initial = existing_dialog_dir(payload.initialDir)
    default_clause = f'default location POSIX file {json.dumps(str(initial))}'
    multiple_clause = " with multiple selections allowed" if payload.multiple else ""
    type_clause = ""
    if kind == "file" and payload.audioOnly:
        exts = ", ".join(json.dumps(ext.lstrip(".")) for ext in sorted(AUDIO_EXTS))
        type_clause = f" of type {{{exts}}}"
    choose = (
        f"choose file {default_clause}{type_clause}{multiple_clause}"
        if kind == "file"
        else f"choose folder {default_clause}{multiple_clause}"
    )
    script = f"""
set pickedItems to {choose}
if class of pickedItems is not list then set pickedItems to {{pickedItems}}
set outText to ""
repeat with pickedItem in pickedItems
  set outText to outText & POSIX path of pickedItem & linefeed
end repeat
return outText
"""
    proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").lower()
        if "user canceled" in err or "uživatel zrušil" in err:
            return []
        raise RuntimeError(proc.stderr.strip() or "Finder dialog failed")
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def fs_node(path: Path, name: str | None = None, kind: str = "folder") -> dict[str, Any]:
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        resolved = path.expanduser()
    has_children = False
    audio_count = 0
    try:
        if resolved.is_dir():
            for child in resolved.iterdir():
                if child.name.startswith("."):
                    continue
                if child.is_dir():
                    has_children = True
                elif child.is_file() and child.suffix.lower() in AUDIO_EXTS:
                    audio_count += 1
    except OSError:
        pass
    return {
        "id": str(resolved),
        "name": name or resolved.name or str(resolved),
        "path": str(resolved),
        "kind": kind,
        "hasChildren": has_children,
        "audioCount": audio_count,
    }


def root_nodes() -> list[dict[str, Any]]:
    roots: list[tuple[Path, str, str]] = [
        (Path.home() / "Music", "Local Music", "music"),
        (Path("/Volumes"), "Volumes", "volumes"),
        (Path.home() / "Desktop", "Desktop", "desktop"),
        (Path.home() / "Downloads", "Downloads", "downloads"),
    ]
    destination = str(state.get_settings().get("destination") or "").strip()
    if destination:
        roots.insert(0, (Path(destination).expanduser(), "Download Destination", "downloads"))
    apple_music = Path.home() / "Music" / "Music" / "Media.localized" / "Music"
    if apple_music.exists():
        roots.append((apple_music, "iTunes / Music", "music"))
    out = []
    seen: set[str] = set()
    for path, name, kind in roots:
        try:
            resolved = str(path.expanduser().resolve())
        except OSError:
            continue
        if resolved in seen or not Path(resolved).exists():
            continue
        seen.add(resolved)
        out.append(fs_node(Path(resolved), name=name, kind=kind))
    return out


def allowed_library_roots() -> list[Path]:
    roots = []
    for node in root_nodes():
        try:
            roots.append(Path(node["path"]).resolve())
        except OSError:
            continue
    return roots


def ensure_allowed_library_path(path: Path) -> Path:
    try:
        resolved = path.expanduser().resolve()
    except OSError as exc:
        raise HTTPException(400, str(exc))
    roots = allowed_library_roots()
    if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
        raise HTTPException(403, "path is outside allowed library roots")
    return resolved


def audio_files_in(path: Path, recursive: bool = False) -> list[dict[str, Any]]:
    resolved = ensure_allowed_library_path(path)
    if not resolved.is_dir():
        raise HTTPException(400, "path is not a folder")
    iterator = resolved.rglob("*") if recursive else resolved.iterdir()
    files = []
    try:
        for child in sorted(iterator, key=lambda item: str(item).lower()):
            if child.name.startswith(".") or not child.is_file() or child.suffix.lower() not in AUDIO_EXTS:
                continue
            try:
                stat = child.stat()
            except OSError:
                continue
            files.append({
                "path": str(child),
                "name": child.name,
                "size": stat.st_size,
                "updated_at": int(stat.st_mtime),
            })
    except OSError as exc:
        raise HTTPException(400, str(exc))
    return files


@app.get("/api/client-config")
def client_config():
    return {"apiToken": API_TOKEN}


@app.get("/api/app/state")
def app_state():
    tracks = state.list_tracks(limit=5000)
    ready = sum(1 for t in tracks if t.get("bpm") and t.get("camelot") not in ("", "?"))
    return {
        "status": "running",
        "toolStatus": tool_status(),
        "settings": public_settings(state.get_settings()),
        "library": {"tracks": len(tracks), "ready": ready, "missing": max(0, len(tracks) - ready)},
        "jobs": state.list_jobs(limit=10),
    }


@app.get("/api/settings")
def get_settings():
    return public_settings(state.get_settings())


@app.put("/api/settings")
def put_settings(payload: SettingsPayload):
    return public_settings(state.set_settings(model_data(payload)))


@app.get("/api/tracks")
def get_tracks(q: str = "", limit: int = 500):
    return {"tracks": state.list_tracks(q=q, limit=min(limit, 5000))}


@app.post("/api/tracks")
def post_track(payload: TrackPayload):
    try:
        data = model_data(payload)
        path = ensure_allowed_library_path(Path(data["path"]))
        if not is_audio_path(path):
            raise HTTPException(400, "path is not a supported audio file")
        data["path"] = str(path)
        return state.upsert_track(data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/tracks/import")
def import_tracks(payload: ImportTracksPayload):
    paths, skipped = expand_audio_inputs(
        paths=payload.paths,
        folders=payload.folders,
        recursive=payload.recursive,
    )
    rows = []
    for path in paths:
        rows.append(state.upsert_track({"path": str(path), "source": "import"}))
    return {"tracks": rows, "count": len(rows), "skipped": skipped}


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id: str):
    state.delete_track(track_id)
    return {"ok": True}


@app.post("/api/dialog/files")
def dialog_files(payload: DialogPayload):
    try:
        return {"paths": run_finder_dialog("file", payload)}
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/dialog/folders")
def dialog_folders(payload: DialogPayload):
    try:
        return {"paths": run_finder_dialog("folder", payload)}
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/fs/roots")
def fs_roots():
    return {"roots": root_nodes()}


@app.get("/api/fs/children")
def fs_children(path: str):
    root = ensure_allowed_library_path(Path(path))
    if not root.is_dir():
        raise HTTPException(400, "path is not a folder")
    children = []
    try:
        for child in sorted(root.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
            if child.name.startswith(".") or not child.is_dir():
                continue
            children.append(fs_node(child))
    except OSError as exc:
        raise HTTPException(400, str(exc))
    return {"children": children}


@app.get("/api/fs/audio")
def fs_audio(path: str, recursive: bool = False):
    return {"files": audio_files_in(Path(path), recursive=recursive)}


@app.get("/api/sets")
def get_sets():
    return state.get_sets()


@app.post("/api/sets")
def post_set(payload: SetPayload):
    return state.save_set(payload.name, payload.ids)


@app.post("/api/sets/{name}/load")
def load_set(name: str):
    return state.load_set(name)


@app.delete("/api/sets/{name}")
def delete_set(name: str):
    return state.delete_set(name)


@app.get("/api/sets/{name}/export")
def export_set(name: str, format: str = "m3u"):
    set_name, tracks = state.set_tracks(name)
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in set_name).strip("_") or "prep"
    if format == "json":
        return JSONResponse({"name": set_name, "count": len(tracks), "tracks": tracks})
    lines = ["#EXTM3U"]
    for t in tracks:
        title = f"{t.get('artist') or ''} - {t.get('title') or Path(t.get('path', '')).stem}".strip(" -")
        lines.append(f"#EXTINF:{int(float(t.get('duration') or -1))},{title}")
        lines.append(t["path"])
    body = ("\n".join(lines) + "\n").encode("utf-8")
    return Response(
        body,
        media_type="audio/x-mpegurl; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.m3u"'},
    )


@app.post("/api/jobs/download")
def start_download(payload: DownloadPayload):
    name, data = split_job_name(model_data(payload))
    jid = jobs.start("download", data, download_worker, name=name)
    return job_response(jid)


@app.post("/api/jobs/enhance")
def start_enhance(payload: EnhancePayload):
    name, data = split_job_name(model_data(payload))
    jid = jobs.start("enhance", data, enhance_worker, name=name)
    return job_response(jid)


@app.post("/api/jobs/analyze")
def start_analyze(payload: dict[str, Any]):
    name, data = split_job_name(payload)
    jid = jobs.start("analyze", data, analyze_worker, name=name)
    return job_response(jid)


@app.post("/api/jobs/stems")
def start_stems(payload: dict[str, Any]):
    name, data = split_job_name(payload)
    jid = jobs.start("stems", data, stems_worker, name=name)
    return job_response(jid)


@app.post("/api/jobs/quality")
def start_quality(payload: QualityPayload):
    data = model_data(payload)
    query = str(data.get("query") or "").strip()
    if not query:
        raise HTTPException(400, "query is required")
    data["query"] = query
    name, data = split_job_name(data)
    jid = jobs.start("quality", data, quality_worker, name=name or f"Quality: {query[:80]}")
    return job_response(jid)


@app.post("/api/jobs/similar")
def start_similar(payload: SimilarPayload):
    data = model_data(payload)
    seed = str(data.get("seed") or "").strip()
    if not seed:
        raise HTTPException(400, "seed is required")
    data["seed"] = seed
    data["limit"] = min(max(int(data.get("limit") or 20), 1), 50)
    name, data = split_job_name(data)
    jid = jobs.start("similar", data, similar_worker, name=name or f"Similar: {seed[:80]}")
    return job_response(jid)


@app.get("/api/jobs")
def list_jobs():
    return {"jobs": state.list_jobs()}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    try:
        return jobs.cancel(job_id)
    except KeyError:
        raise HTTPException(404, "job not found")


@app.put("/api/jobs/{job_id}/name")
def rename_job(job_id: str, payload: JobNamePayload):
    try:
        return state.rename_job(job_id, payload.name)
    except KeyError:
        raise HTTPException(404, "job not found")


@app.post("/api/jobs/{job_id}/repeat")
def repeat_job(job_id: str):
    try:
        original = state.get_job(job_id)
    except KeyError:
        raise HTTPException(404, "job not found")
    workers: dict[str, Callable[[str, dict[str, Any], JobManager], None]] = {
        "download": download_worker,
        "enhance": enhance_worker,
        "analyze": analyze_worker,
        "stems": stems_worker,
        "quality": quality_worker,
        "similar": similar_worker,
    }
    worker = workers.get(original["kind"])
    if not worker:
        raise HTTPException(400, f"job kind cannot be repeated: {original['kind']}")
    base_name = clean_job_name(original.get("name") or "")
    repeat_name = f"{base_name} (opakování)" if base_name else ""
    jid = jobs.start(original["kind"], dict(original.get("payload") or {}), worker, name=repeat_name, repeated_from=original["id"])
    return job_response(jid)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    try:
        return state.get_job(job_id)
    except KeyError:
        raise HTTPException(404, "job not found")


@app.get("/api/jobs/{job_id}/events")
def job_events(job_id: str):
    try:
        state.get_job(job_id)
    except KeyError:
        raise HTTPException(404, "job not found")

    def event_stream():
        yield f"data: {json_dumps({'job': state.get_job(job_id)})}\n\n"
        gen = bus.subscribe(job_id)
        q = next(gen)
        try:
            while True:
                try:
                    event = q.get(timeout=15)
                    yield f"data: {json_dumps(event)}\n\n"
                    job = event.get("job") or {}
                    if job.get("status") in {"done", "error", "cancelled"}:
                        break
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            try:
                gen.close()
            except Exception:
                pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/quality")
def quality(query: str):
    if not query.strip():
        raise HTTPException(400, "query is required")
    try:
        return {"results": legacy.quality_finder(query.strip())}
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"quality probe failed: {exc}")


@app.get("/api/similar")
def similar(seed: str, limit: int = 15):
    if not seed.strip():
        raise HTTPException(400, "seed is required")
    try:
        return {"tracks": legacy.fetch_similar_tracks(seed.strip(), limit=min(max(limit, 1), 50))}
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"similar tracks lookup failed: {exc}")


@app.post("/api/live/start")
def live_start():
    return {"status": "running", "url": "/live", "tracks": len(live_rows())}


@app.post("/api/live/stop")
def live_stop():
    return {"status": "stopped"}


@app.post("/api/live/refresh")
def live_refresh():
    return {"status": "refreshed", "tracks": len(live_rows())}


@app.get("/library.json")
def compatibility_library():
    return live_rows()


@app.get("/prepare.json")
def compatibility_prepare():
    sets = state.get_sets()
    active = sets.get("active_set") or "PREP"
    row = next((s for s in sets["sets"] if s["name"] == active), {"ids": []})
    return {"ids": row.get("ids", []), "active_set": active}


@app.post("/prepare")
async def compatibility_prepare_update(request: Request):
    payload = await request.json()
    ids = payload.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(400, "ids must be a list")
    active = state.get_sets().get("active_set") or "PREP"
    state.save_set(active, ids)
    return compatibility_prepare()


@app.get("/sets.json")
def compatibility_sets():
    return state.get_sets()


@app.post("/sets")
async def compatibility_sets_update(request: Request):
    payload = await request.json()
    action = payload.get("action") or "save"
    name = payload.get("name")
    if action == "save":
        ids = payload.get("ids")
        if not isinstance(ids, list):
            raise HTTPException(400, "ids must be a list")
        state.save_set(name, ids)
    elif action == "load":
        state.load_set(name)
    elif action == "delete":
        state.delete_set(name)
    else:
        raise HTTPException(400, f"unknown action: {action}")
    out = state.get_sets()
    out["ids"] = compatibility_prepare()["ids"]
    return out


@app.get("/runtime.json")
def compatibility_runtime():
    if MIDI_BRIDGE:
        return MIDI_BRIDGE.runtime_info()
    return {"midi_ws_url": None, "native_midi_available": False, "native_midi_error": MIDI_ERROR}


@app.post("/stems")
def compatibility_stems(id: str):
    jid = jobs.start("stems", {"trackIds": [id]}, stems_worker)
    return {"status": "running", "job": jid}


@app.get("/stems/status")
def compatibility_stems_status(id: str):
    return {"status": "idle"}


@app.get("/export")
def compatibility_export(format: str = "m3u", set: str | None = None):
    return export_set(set or state.get_sets().get("active_set") or "PREP", format=format)


@app.get("/audio")
def audio(id: str, request: Request):
    track = next((t for t in live_rows() if t["id"] == id), None)
    if not track:
        raise HTTPException(404, "track id not found")
    path = ensure_allowed_library_path(Path(track.get("_path") or track.get("path") or ""))
    if not is_audio_path(path):
        raise HTTPException(404, "file missing on disk")
    return range_response(path, request)


def range_response(path: Path, request: Request) -> Response:
    size = path.stat().st_size
    ctype, _ = mimetypes.guess_type(str(path))
    ctype = ctype or "audio/mpeg"
    start = 0
    end = size - 1
    status = 200
    rng = request.headers.get("range")
    if rng and rng.startswith("bytes="):
        try:
            spec = rng[6:].strip()
            raw_start, raw_end = spec.split("-", 1)
            if raw_start:
                start = int(raw_start)
            if raw_end:
                end = int(raw_end)
            if start < 0 or end >= size or start > end:
                raise ValueError
            status = 206
        except ValueError:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    length = end - start + 1

    def iterator():
        with path.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "X-Content-Type-Options": "nosniff",
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(iterator(), status_code=status, media_type=ctype, headers=headers)


def paths_from_payload(payload: dict[str, Any], manager: JobManager | None = None, jid: str | None = None) -> list[Path]:
    paths, skipped = expand_audio_inputs(
        paths=payload.get("paths") or [],
        folders=payload.get("folders") or [],
        recursive=bool(payload.get("recursive", True)),
    )
    seen = {str(p) for p in paths}
    for tid in payload.get("trackIds") or []:
        try:
            path = Path(state.get_track(tid)["path"]).expanduser().resolve()
            ensure_allowed_library_path(path)
        except KeyError:
            skipped.append(f"track:{tid}")
            continue
        except HTTPException:
            skipped.append(f"track:{tid}")
            continue
        except OSError:
            skipped.append(str(tid))
            continue
        if str(path) not in seen and is_audio_path(path):
            seen.add(str(path))
            paths.append(path)
    if manager and jid and skipped:
        manager.log(jid, f"Skipped {len(skipped)} non-audio/missing inputů.\n")
    return paths


def download_worker(jid: str, payload: dict[str, Any], manager: JobManager) -> None:
    settings = state.get_settings()
    dest = payload.get("destination") or settings["destination"]
    quality = payload.get("quality") or settings["quality"]
    quality = normalize_quality(quality)
    opts = {**(settings.get("options") or {}), **(payload.get("options") or {})}
    Path(dest).mkdir(parents=True, exist_ok=True)
    items = [x.strip() for x in payload.get("items") or [] if str(x).strip()]
    if not items:
        raise RuntimeError("No download items provided")
    for i, item in enumerate(items, 1):
        manager.check_cancelled(jid)
        src = legacy.detect_source(item)
        if src == "soundcloud":
            flags: list[str] = []
            cmd = legacy.scdl_command(item, dest, quality, flags, opts)
            tool = "scdl"
        elif src == "spotify":
            cmd = legacy.spotdl_command(item, dest, quality, opts)
            tool = "spotdl"
        elif src == "search":
            cmd = legacy.ytdlp_command(f"ytsearch1:{item}", dest, quality, opts)
            tool = "yt-dlp(search)"
        else:
            cmd = legacy.ytdlp_command(item, dest, quality, opts)
            tool = "yt-dlp"
        if not cmd:
            manager.log(jid, f"!! Chybí nástroj pro {tool}\n")
            continue
        manager.log(jid, f"[{i}/{len(items)}] {tool}: {item}\n", progress=(i - 1) / len(items) * 100)
        manager.begin_step(jid, item, tool)
        proc = None
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            manager.set_process(jid, proc)
            assert proc.stdout is not None
            for line in proc.stdout:
                manager.check_cancelled(jid)
                parsed = legacy.parse_progress(line)
                progress = ((i - 1) + (parsed.get("pct", 0) / 100 if parsed else 0)) / len(items) * 100
                manager.log(jid, line, progress=progress)
            rc = proc.wait()
            manager.check_cancelled(jid)
            if rc != 0:
                manager.log(jid, f"!! Exit code {rc}: {item}\n")
        except OSError as exc:
            raise RuntimeError(f"Subprocess start selhal: {exc}") from exc
        finally:
            if proc is not None:
                manager.set_process(jid, None)
            manager.clear_step(jid)
    manager.update(jid, status="done", progress=100, message="Download hotov")


class QueueLog:
    def __init__(self, jid: str, manager: JobManager):
        self.jid = jid
        self.manager = manager

    def put(self, line: str) -> None:
        self.manager.log(self.jid, str(line))


def run_job_command(
    jid: str,
    manager: JobManager,
    cmd: list[str],
    *,
    track: Path,
    step: str,
    timeout: int,
) -> subprocess.CompletedProcess[str]:
    manager.check_cancelled(jid)
    manager.begin_step(jid, str(track), step, timeout=timeout)
    manager.log(jid, f"[{track.name}] {step}\n")
    manager.log(jid, f"$ {' '.join(cmd)}\n")
    proc = None
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        manager.set_process(jid, proc)
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            manager._stop_process(jid, proc, "timeout")
            stdout, stderr = proc.communicate()
            if stdout:
                manager.log(jid, stdout[-2000:])
            if stderr:
                manager.log(jid, stderr[-2000:])
            raise JobStepTimeout(f"Timeout po {timeout // 60} minutách") from exc
        if manager.step_timed_out(jid):
            if stdout:
                manager.log(jid, stdout[-2000:])
            if stderr:
                manager.log(jid, stderr[-2000:])
            raise JobStepTimeout(f"Timeout po {timeout // 60} minutách")
        manager.check_cancelled(jid)
        if stdout:
            manager.log(jid, stdout[-2000:])
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    except FileNotFoundError as exc:
        raise RuntimeError(f"Chybí nástroj: {cmd[0]}") from exc
    except OSError as exc:
        raise RuntimeError(f"Subprocess start selhal: {exc}") from exc
    finally:
        if proc is not None:
            manager.set_process(jid, None)
        manager.clear_step(jid)


def backend_enhance_file(in_path: Path, opts: dict[str, Any], jid: str, manager: JobManager) -> Path | None:
    suffix = in_path.suffix.lower()
    out_dir = in_path.parent / "_enhanced"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{in_path.stem}_enhanced{suffix}"
    af = legacy.build_enhance_filter(opts)
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(in_path)]
    if af:
        cmd += ["-af", af]
    if suffix == ".mp3":
        cmd += ["-c:a", "libmp3lame", "-q:a", "0"]
    elif suffix == ".flac":
        cmd += ["-c:a", "flac"]
    elif suffix in (".m4a", ".aac"):
        cmd += ["-c:a", "aac", "-b:a", "256k"]
    elif suffix == ".opus":
        cmd += ["-c:a", "libopus", "-b:a", "192k"]
    elif suffix == ".wav":
        cmd += ["-c:a", "pcm_s16le"]
    else:
        cmd += ["-c:a", "libmp3lame", "-q:a", "0"]
        out_path = out_dir / f"{in_path.stem}_enhanced.mp3"
    cmd.append(str(out_path))
    proc = run_job_command(jid, manager, cmd, track=in_path, step="Manual Enhance render", timeout=ENHANCE_TRACK_TIMEOUT)
    if proc.returncode != 0:
        detail = proc.stderr.splitlines()[-1] if proc.stderr else "?"
        manager.log(jid, f"!! ffmpeg fail: {detail}\n")
        return None
    return out_path


def backend_club_master_file(in_path: Path, jid: str, manager: JobManager) -> Path | None:
    out_dir = in_path.parent / "_enhanced"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{in_path.stem}_club.wav"
    target_i = "-9"
    target_lra = "7"
    target_tp = "-1.0"
    measure_filter = f"loudnorm=I={target_i}:LRA={target_lra}:TP={target_tp}:print_format=json"
    measure_cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(in_path),
        "-af", measure_filter, "-f", "null", "-",
    ]
    measured = run_job_command(
        jid,
        manager,
        measure_cmd,
        track=in_path,
        step="Club Master loudness measure",
        timeout=CLUB_MASTER_MEASURE_TIMEOUT,
    )
    if measured.returncode != 0:
        detail = measured.stderr.splitlines()[-1] if measured.stderr else "?"
        manager.log(jid, f"!! ffmpeg measure fail: {detail}\n")
        return None
    stats = legacy._parse_loudnorm_json(measured.stderr)
    if not stats:
        manager.log(jid, "!! ffmpeg nevrátil loudnorm měření\n")
        return None
    master_filter = (
        f"loudnorm=I={target_i}:LRA={target_lra}:TP={target_tp}:"
        f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats.get('target_offset', '0')}:linear=true:print_format=summary,"
        "aresample=48000"
    )
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(in_path),
        "-af", master_filter, "-c:a", "pcm_s24le", "-ar", "48000",
        "-ac", "2", str(out_path),
    ]
    rendered = run_job_command(
        jid,
        manager,
        cmd,
        track=in_path,
        step="Club Master render",
        timeout=ENHANCE_TRACK_TIMEOUT,
    )
    if rendered.returncode != 0:
        detail = rendered.stderr.splitlines()[-1] if rendered.stderr else "?"
        manager.log(jid, f"!! ffmpeg club master fail: {detail}\n")
        return None
    return out_path


def enhance_worker(jid: str, payload: dict[str, Any], manager: JobManager) -> None:
    paths = paths_from_payload(payload, manager, jid)
    if not paths:
        raise RuntimeError("No tracks selected")
    mode = payload.get("mode") or "manual"
    opts = payload.get("options") or {}
    out: list[str] = []
    failed: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    try:
        for i, path in enumerate(paths, 1):
            manager.check_cancelled(jid)
            manager.log(jid, f"Enhance [{i}/{len(paths)}] {path.name}\n", progress=(i - 1) / len(paths) * 100)
            try:
                result = backend_club_master_file(path, jid, manager) if mode == "club" else backend_enhance_file(path, opts, jid, manager)
            except JobStepTimeout as exc:
                reason = str(exc)
                skipped.append({"path": str(path), "reason": reason})
                manager.log(jid, f"!! {reason}: {path.name}; přeskakuji track\n")
                continue
            if result:
                out.append(str(result))
                manager.log(jid, f"OK: {result.name}\n")
            else:
                failed.append({"path": str(path), "reason": "ffmpeg failed"})
                manager.log(jid, f"!! Track selhal, pokračuji: {path.name}\n")
            manager.update(jid, progress=i / len(paths) * 100)
    except JobCancelled:
        manager.update(
            jid,
            status="cancelled",
            message="Enhance zrušen",
            result={"files": out, "failed": failed, "skipped": skipped, "cancelled": 1},
        )
        raise
    manager.update(
        jid,
        status="done",
        progress=100,
        message=f"Enhance hotov: {len(out)} OK, {len(failed)} failed, {len(skipped)} skipped",
        result={"files": out, "failed": failed, "skipped": skipped, "cancelled": 0},
    )


def analyze_worker(jid: str, payload: dict[str, Any], manager: JobManager) -> None:
    paths = paths_from_payload(payload, manager, jid)
    if not paths:
        raise RuntimeError("No tracks selected")
    analyzed = []
    for i, path in enumerate(paths, 1):
        manager.check_cancelled(jid)
        manager.log(jid, f"Analýza [{i}/{len(paths)}] {path.name}\n", progress=(i - 1) / len(paths) * 100)
        res = legacy.analyze_track(path)
        manager.check_cancelled(jid)
        if res and "error" not in res:
            row = state.upsert_track({"path": str(path), **res, "source": "analysis"})
            analyzed.append(row)
    manager.update(jid, status="done", progress=100, message="Analýza hotová", result={"tracks": analyzed})


def stems_worker(jid: str, payload: dict[str, Any], manager: JobManager) -> None:
    paths = paths_from_payload(payload, manager, jid)
    if not paths:
        # compatibility route sends live track ids not DB ids
        by_live = {t["id"]: t for t in live_rows()}
        paths = [Path(by_live[tid]["_path"]) for tid in payload.get("trackIds", []) if tid in by_live]
    if not paths:
        raise RuntimeError("No tracks selected")
    out = []
    log = QueueLog(jid, manager)
    for i, path in enumerate(paths, 1):
        manager.check_cancelled(jid)
        manager.log(jid, f"Stems [{i}/{len(paths)}] {path.name}\n", progress=(i - 1) / len(paths) * 100)
        result = legacy.stem_separate(path, log)
        manager.check_cancelled(jid)
        if result:
            out.append(str(result))
    manager.update(jid, status="done", progress=100, message="Stems hotové", result={"folders": out})


def quality_worker(jid: str, payload: dict[str, Any], manager: JobManager) -> None:
    query = str(payload.get("query") or "").strip()
    if not query:
        raise RuntimeError("query is required")
    manager.check_cancelled(jid)
    manager.log(jid, f"Quality probe: {query}\n", progress=5)
    rows = legacy.quality_finder(query)
    manager.check_cancelled(jid)
    ok_count = sum(1 for row in rows if row.get("ok"))
    manager.update(
        jid,
        status="done",
        progress=100,
        message=f"Quality hotová: {ok_count}/{len(rows)} zdrojů OK",
        result={"results": rows},
    )


def similar_worker(jid: str, payload: dict[str, Any], manager: JobManager) -> None:
    seed = str(payload.get("seed") or "").strip()
    if not seed:
        raise RuntimeError("seed is required")
    limit = min(max(int(payload.get("limit") or 20), 1), 50)
    manager.check_cancelled(jid)
    manager.log(jid, f"Similar lookup: {seed}\n", progress=5)
    tracks = legacy.fetch_similar_tracks(seed, limit=limit)
    manager.check_cancelled(jid)
    manager.update(
        jid,
        status="done",
        progress=100,
        message=f"Podobné hotovo: {len(tracks)} tracků",
        result={"tracks": tracks},
    )


if DJ_DIR.is_dir():
    app.mount("/dj", StaticFiles(directory=DJ_DIR), name="dj")


@app.get("/car.html")
def car_html():
    return FileResponse(DJ_DIR / "car.html")


@app.get("/live")
def live_html():
    return FileResponse(DJ_DIR / "index.html")


@app.get("/{full_path:path}")
def frontend(full_path: str):
    requested = WEB_DIST / full_path
    if full_path and requested.is_file() and requested.resolve().is_relative_to(WEB_DIST.resolve()):
        return FileResponse(requested)
    dj_requested = DJ_DIR / full_path
    if full_path and dj_requested.is_file() and dj_requested.resolve().is_relative_to(DJ_DIR.resolve()):
        return FileResponse(dj_requested)
    if WEB_INDEX.is_file():
        return FileResponse(WEB_INDEX)
    return HTMLResponse(
        "<h1>SCDL GUI backend běží</h1><p>Frontend ještě není sestavený. Spusť <code>npm install && npm run build</code> ve složce <code>web</code>.</p>",
        status_code=200,
    )


def find_free_port(host: str, start: int) -> int:
    for port in range(start, start + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found from {start}")


def main() -> None:
    import argparse
    import webbrowser

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SCDL_GUI_PORT", "8765")))
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"} and not os.environ.get("SCDL_GUI_API_TOKEN"):
        raise SystemExit("Refusing non-loopback bind without SCDL_GUI_API_TOKEN")
    port = find_free_port(args.host, args.port)
    url = f"http://{args.host}:{port}/library"
    print(f"SCDL GUI DJ OS běží na {url}", flush=True)
    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    config = uvicorn.Config(app, host=args.host, port=port, log_level="info")
    server = uvicorn.Server(config)

    def stop(*_: Any) -> None:
        server.should_exit = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    server.run()


if __name__ == "__main__":
    main()
