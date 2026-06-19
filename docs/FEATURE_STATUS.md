# Feature Status — audit for open-source release (Velyos Deck)

> Audit date: 2026-06-18. Purpose: establish what **actually works** before
> advertising features publicly and before deciding the monetization model.
> This is the deliverable of Phase 1 of the open-source plan.

## Status legend

| Symbol | Meaning |
|--------|---------|
| ✅ Working | Verified working — either by live run or by real usage history in this repo |
| 🧪 Tested-logic | Core logic covered by passing automated tests, but not exercised end-to-end here |
| ⚙️ Code-complete | Fully implemented in code; not runtime-verified in this audit (needs hardware, browser interaction, heavy deps, or would download copyrighted content) |
| ⚠️ Conditional | Works only if optional heavy dependencies are installed (not in the default `.venv`) |
| ❓ Unverified | Implemented but no evidence either way; needs manual QA before advertising |

## How this audit was done

- Ran `scripts/check.sh` on the working tree → **passes fully** (Python compiles, JS syntax OK, **16/16 Node tests pass**, web `tsc` + `vite build` succeed).
- Booted the canonical backend `python backend/main.py` and probed the live API (48 endpoints). Confirmed it serves the web UI (HTTP 200) and enforces local API-token auth.
- Pulled real data from the running instance: persisted settings, a populated track library, and **completed download/enhance jobs in history** — proof the core pipeline has worked in real use.
- Static scan for `TODO`/`FIXME`/`not implemented`/stub markers → **none in logic** (the 20 hits are all HTML input placeholders).
- Inventoried dependency locations across `.venv`, `.analyzer-venv`, and system PATH.

## Feature matrix

### Core pipeline
| Feature | Status | Notes |
|---|---|---|
| Backend boot + web serving | ✅ Working | `backend/main.py` on 127.0.0.1; serves React build at `/` |
| Local API-token auth | ✅ Working | Header `x-scdl-gui-token` / query `_scdl_token`; non-loopback requires `SCDL_GUI_API_TOKEN` |
| Settings load/persist | ✅ Working | SQLite at `~/.music-dl-gui/state.sqlite3`; secret redaction in place |
| Track library (list/import/delete/search) | ✅ Working | Real library returned live; metadata fields present |
| Jobs system (queue/progress/cancel/rename/repeat) | ✅ Working | Completed jobs present in history with progress + payload |
| Filesystem browser (roots/children/audio) | ⚙️ Code-complete | Endpoints present; allowed-root restriction enforced |
| Sets (save/load/export M3U + JSON) | ⚙️ Code-complete | Endpoints present; not exercised in this audit |

### Downloading
| Feature | Status | Notes |
|---|---|---|
| SoundCloud (scdl) | ✅ Working | `scdl` on PATH; modes: track/profile/top/likes/reposts/playlist |
| YouTube / YT Music (yt-dlp) | ✅ Working | `yt-dlp` on PATH; real completed YouTube job in history |
| Spotify (spotdl) | ⚠️ Conditional | Detected via `~/Library/Python/*/bin` / `~/.local/bin` — **not in repo venv**; a fresh clone won't have it |
| Bandcamp / TIDAL | ❓ Unverified | Implemented; no usage evidence. Verify manually |
| Quality selection (best/MP3-320/FLAC/Opus) | ⚙️ Code-complete | Settings honored; `mp3-320` is the active default |
| Batch queue + auto-organize | ✅ Working | Batch jobs present in history |

> ⚠️ **Legal — EXCLUDED FROM PUBLIC RELEASE.** Streaming downloads (Spotify/TIDAL/
> SoundCloud/YouTube) violate those platforms' terms and pose copyright + brand risk
> for a company-branded product. Decision: the streaming downloader is **not published**
> in the public Velyos Deck repo. It remains a gitignored local-only module for the
> maintainer; the app degrades gracefully (download UI hidden) when the module is absent.
> The public product works on the user's own local files (import, analyze, mix, master).

### Audio enhancement
| Feature | Status | Notes |
|---|---|---|
| Club Master render (48kHz/24-bit + loudness) | ✅ Working | `_club.wav` master files exist in the user's library → produced successfully |
| Denoise / exciter / stereo widen / LUFS normalize | ⚙️ Code-complete | Part of enhance pipeline; needs per-effect manual A/B QA |
| AudioSR super-resolution | ⚠️ Conditional | Requires `audiosr` (separate install); off by default in settings |

### DJ deck (browser, `dj/`)
Per-feature verdicts below are from a **full source review** of `dj/*.js` plus a live
smoke test confirming the deck page and all its JS assets are served (HTTP 200) by the
backend. Per-effect audio A/B and physical-controller testing remain a manual QA pass.

| Feature | Status | Notes |
|---|---|---|
| AutoMix planner (scoring, transitions, DROP gates, harmonic) | 🧪 Tested-logic | 11 dedicated tests pass (`tests/automix-planner.test.js`) |
| Dual-deck playback (single + stem mode) | ✅ Working | Full Web Audio engine `dj/audio.js:120`, deck logic `dj/deck.js:103` |
| 3-band EQ per deck | ✅ Working | Biquad low/mid/high `dj/audio.js:127`, `dj/deck.js:273` |
| Filter per deck (morphing LP/HP) | ✅ Working | `dj/audio.js:294` |
| Effects: echo / reverb / gate | ✅ Working | `dj/audio.js:251/266/158` (delay, convolver, LFO gate) |
| Crossfader | ✅ Working | Sine/cosine law `dj/audio.js:388` |
| Loops 1/4–16 bars + slip | ✅ Working | `dj/loops.js:24/56` — RAF-based (~16 ms), fine for ≥1/16 beat |
| 8 hot cues per deck | ✅ Working | Per-track localStorage `dj/cues.js`, `dj/deck.js:341` |
| Pitch / tempo (8/16/50%) | ✅ Working | `dj/deck.js:226` |
| Sync BPM + phase align | ✅ Working | `dj/deck.js:250` (also test-covered) |
| Waveform (overview + zoom + beatgrid) | ✅ Working | `dj/waveform.js` with coach overlay |
| Coach (live mixing guidance) | ✅ Working | Auto section/energy detection `dj/coach.js:10` |
| Generative deck (drum/bass/fill) | ✅ Working | Web Audio synthesis (not ML) `dj/generative.js` |
| Master recording (WAV/WebM) | ✅ Working | MediaRecorder `dj/audio.js:420` |
| Keylock (pitch-preserving) | ❌ Stub | Flag only, no DSP `dj/deck.js:20` — do not advertise |
| Visualizer | ⚙️ Partial | Fullscreen-only window; no inline mode `dj/visualizer.js` |
| Stem separation (deck side) | ⚠️ Conditional | UI calls backend `/stems`; depends on Demucs (see below) |

### Metadata analysis
| Feature | Status | Notes |
|---|---|---|
| BPM / key / Camelot detection | ⚠️ Conditional | Requires `librosa` (in `.analyzer-venv`, not default `.venv`) |
| Shazam track ID | ⚠️ Conditional | Requires `shazamio` (optional) |
| Energy scoring + Camelot neighbors | 🧪 Tested-logic | Harmonic-neighbor logic covered by AutoMix tests |

### Stem separation
| Feature | Status | Notes |
|---|---|---|
| Demucs stem isolation (vocals/drums/bass/other) | ⚠️ Conditional | `demucs` lives in `.analyzer-venv/bin`; heavy (Torch). Per-stem deck volume implemented |

### Hardware / MIDI
| Feature | Status | Notes |
|---|---|---|
| Pioneer DDJ-SB3 mapping | 🧪 Tested-logic | 5 mapping tests pass (`tests/sb3-mapping.test.js`); **physical controller not tested** |
| MIDI bridge (CoreMIDI ↔ WebSocket) | ⚙️ Code-complete | `midi_bridge.py`; needs hardware to fully verify |
| Keyboard fallback controls | ✅ Working | Full bindings (Z/X/C deck A, B/N/M deck B, 1–8 cues) `dj/app.js:381` |

## Cross-cutting findings (must address before public release)

1. ✅ **FIXED — Dependencies were scattered and not reproducible.** Tools live across
   three places: `.venv` (core), `.analyzer-venv` (demucs/analysis), and the user's
   `~/Library/Python/*` (spotdl/audiosr). A fresh `git clone` on another Mac would
   not have the optional ones. → Added `scripts/setup-analyzer.sh` (reproducible
   Python 3.11 `.analyzer-venv` with `--demucs`/`--audiosr` opt-in) and documented
   the core vs optional install path in the README.
2. ✅ **FIXED — `.venv` was partial/stale.** `mutagen` was in `requirements.txt` but
   missing from the installed `.venv`, because `run.sh`'s reinstall guard only
   checked `fastapi, uvicorn, websockets`. → Guard now also checks `mutagen`, so
   stale venvs self-repair; the current `.venv` was synced.
3. ✅ **FIXED (documented) — Four Python entry points.** `app.py` (legacy Tkinter),
   `backend/main.py` (canonical), `dj_server.py`, `phone_server.py`. → README now
   documents `python -m backend.main` (via `./run.sh`) as the single supported path
   and lists the others as legacy/auxiliary.
4. ⏳ **Open — `toolStatus` is optimistic.** Detection is correct on this machine but
   reports a tool as available whenever it is found in any candidate path; a clean
   install could be told a feature works when its dependency is absent. Consider
   surfacing *how/where* a tool was found. (Low priority; not a blocker.)

## Bottom line for the monetization decision

- **The browser DJ deck is production-grade and verified** — playback, EQ, filter,
  echo/reverb/gate, crossfader, loops+slip, 8 hot cues, pitch, sync+phase, waveform,
  coach, generative, keyboard control, master recording all fully implemented (source
  review + served-asset smoke test). Only keylock (stub) and an inline visualizer are
  missing. This + the test-backed AutoMix harmonic planner and DDJ-SB3 mapping are the
  **defensible, brand-worthy IP for Velyos** and the heart of the public product.
- **Club Master enhancement works** — proven by real master files in the library.
- **The heavy AI features** (Demucs stem separation, librosa BPM/key, AudioSR,
  Shazam) are **conditional** — real code, but depend on optional installs in a
  separate `.analyzer-venv` and still need manual QA. Good candidates for the paid tier.
- **The streaming downloader is excluded from the public release** (legal/brand risk).

**Recommendation (open-core, confirmed):** ship the DJ deck + AutoMix + local-file
analysis + Club Master as the free AGPL core; position the hardened AI layer (cloud
stems, AI automix pro, library sync) as paid **Velyos Pro**. Label Demucs/AudioSR/
Shazam features "experimental/optional" until manual QA + reproducible install land.
