# Development Handbook

Status date: 2026-06-10

This is the canonical human development guide for Velyos Deck. For AI-specific working context, see `AGENTS.md`.

## Current State

Velyos Deck is a local-first macOS DJ workstation. The project currently includes:

- Legacy Tkinter desktop app in `app.py` for downloads, enhancement, analysis, and local DJ workflows.
- FastAPI backend in `backend/main.py` with SQLite state, job management, React UI serving, compatibility endpoints, local API token protection, secret redaction, and allowed-root filesystem/audio access.
- Vite/React web UI in `web/` for Library, Download, Quality, Similar, Enhance, Live, Jobs, and Settings views.
- Browser DJ deck in `dj/` with library browsing, sets/PREP queue, AutoMix planning, MIDI mapping, waveform, cues, visualizer, and audio playback.
- Local HTTP DJ server in `dj_server.py`, CoreMIDI bridge in `midi_bridge.py`, and LAN phone proxy in `phone_server.py`.
- Automated checks through `scripts/check.sh`, GitHub Actions, and Node tests for AutoMix/SB3 behavior.
- Release readiness docs, MIT license, security policy, contribution guide, SBOM starter, and GitHub issue/PR templates.

The project is ready to continue in a private GitHub repository once all intended source directories are tracked and checks pass on a fresh clone. Public open-source release still requires legal review of downloader workflows and a complete third-party license/SBOM review.

## Architecture

Primary flows:

- Desktop/local tools: `app.py` and backend workers invoke external tools such as `scdl`, `yt-dlp`, `spotdl`, `ffmpeg`, Demucs, and optional AudioSR.
- Web app: Vite serves React in development; the FastAPI backend serves `web/dist` in built mode.
- Backend state: `backend/main.py` stores settings, tracks, sets, and jobs in SQLite under `SCDL_GUI_DATA_DIR` or `~/.music-dl-gui`.
- Jobs: download, enhance, analyze, stems, quality, and similar jobs are persisted, cancellable, repeatable, and watchdog-protected against stale/running failures.
- DJ compatibility: `/library.json`, `/audio`, `/prepare`, `/sets`, `/runtime.json`, `/stems`, and `/export` preserve legacy browser DJ flows.
- Audio access: audio files are served with Range support only when they are known tracks and inside allowed library roots.

Important boundaries:

- `backend/main.py` is the new local web backend and job/state authority.
- `app.py` remains the legacy desktop orchestration surface and still contains downloader and audio-processing helpers reused by the backend.
- `dj/*.js` is a separate vanilla browser DJ app and should not be treated as part of the React build.
- `phone_server.py` intentionally binds for LAN phone use and remains higher risk than loopback-only routes.

## Completed Features

Application workflows:

- Download queue support for SoundCloud, YouTube/search, Spotify via external tools, and quality selection.
- Quality and Similar web workflows run through the backend job system with progress, cancellation, repeat support, and visible errors.
- Library import from files/folders, lazy folder tree browsing, PREP/set save/load/export, and metadata display.
- Analyzer workflow for BPM, key, Camelot, genre/tags/energy metadata, and optional Shazam lookup.
- Enhance workflow with Manual filters and Club Master mode, recursive input selection, progress polling, timeout handling, and cancellation.
- Stems workflow via Demucs where available.
- Jobs view with names, rename, repeat, cancel, status, stale warnings, and persisted history.
- Settings view with destination picker, CZ/EN language selection, and service connection fields without full OAuth.
- Live/DJ launch compatibility for the browser DJ deck.

Security and reliability:

- Backend binds to `127.0.0.1` by default.
- Non-loopback backend bind is refused unless `SCDL_GUI_API_TOKEN` is set.
- Protected API/audio/compatibility routes require `X-SCDL-GUI-Token` or `_scdl_token`.
- `/api/client-config` is loopback-only and lets the React UI bootstrap the per-run token.
- Settings responses redact secret values and expose only configured/unconfigured state.
- Job payloads, messages, logs, and results redact common token/secret patterns.
- Filesystem browsing, imports, and audio streaming are constrained to configured local library roots.
- SQLite connections are closed through a context manager to avoid file descriptor leaks.
- Job watchdog marks stale jobs and terminates timed-out subprocess steps.
- DJ server mutating endpoints have same-origin checks; MIDI bridge validates local browser origins.

Documentation and release readiness:

- MIT license, README, CONTRIBUTING, SECURITY, CHANGELOG, NOTICE, `.env.example`, GitHub templates, CI workflow, SBOM starter, and readiness audit exist.
- `.gitignore` excludes local media, SQLite state, virtual environments, build outputs, caches, logs, and `.env` files.

## Development Setup

Required local tools:

- macOS for Finder picker and legacy Tk UI.
- Python 3.11 or newer.
- Node.js 20 with npm 10 for reproducible frontend builds.
- `ffmpeg` on `PATH`.
- Optional workflow tools: `scdl`, `yt-dlp`, `spotdl`, Demucs/Torch, AudioSR, analyzer packages from `requirements-analyzer.txt`, and native MIDI dependencies.

Initial setup:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

cd web
npm ci
npm run build
cd ..
```

Run built backend:

```bash
python backend/main.py
```

Run development backend and frontend:

```bash
python backend/main.py --no-open
cd web
npm run dev
```

Useful environment variables:

- `SCDL_GUI_DATA_DIR`: override runtime state directory.
- `SCDL_GUI_PORT`: choose backend start port.
- `SCDL_GUI_API_TOKEN`: set an explicit local API token, required for non-loopback bind.

Default local data:

- SQLite state: `~/.music-dl-gui/state.sqlite3`.
- Legacy config/cache/state: `~/.music-dl-gui.json`, `~/.music-dl-gui-dj-cache.json`, `~/.music-dl-gui-dj-state.json`.
- Generated media: `_enhanced/` and `_stems/` near source media.

## Verification

Standard check:

```bash
./scripts/check.sh
```

The script compiles Python modules, validates DJ JavaScript syntax, runs Node tests, runs web typecheck/build, and checks whitespace with `git diff --check`. It intentionally fails if `web/node_modules` is missing; run `cd web && npm ci` first.

Additional release hygiene checks:

```bash
git status --short
git ls-files backend web tests scripts
```

Run the secret smoke scan from `.github/workflows/ci.yml` before staging release changes. Keep the scan pattern out of documentation examples so the docs do not match the scan themselves.

Expected current test coverage:

- Node tests cover AutoMix planner edge cases and DDJ-SB3 mapping behavior.
- Web typecheck/build covers React/TypeScript integration.
- Python currently has compile/import smoke coverage through `scripts/check.sh`, but needs a real backend pytest suite.

Recommended missing tests:

- Backend token enforcement, settings redaction/preservation, allowed-root filesystem checks, audio Range responses, job lifecycle, watchdog, and repeat/cancel behavior.
- Frontend tests for Enhance payload/polling/cancel and Jobs rename/repeat/cancel.
- Integration smoke for fresh clone setup and built backend serving the React app.

## Security Model

This project is a trusted local tool, not a hosted service.

- Keep backend loopback-only unless there is a deliberate trusted-LAN use case.
- Never expose the backend to the internet.
- Do not commit local media, SQLite state, `.env` files, tokens, cookies, private URLs, generated stems/enhanced audio, virtual environments, `node_modules`, or `web/dist`.
- Downloader workflows must only be used for content the user owns, is licensed to use, or is allowed to download/process by the rights holder and service terms.
- Public release requires legal review for SoundCloud, YouTube, Spotify, Bandcamp, and TIDAL workflows.

Known residual risks:

- `phone_server.py` is LAN-facing and currently trusted-LAN-only.
- External CLI behavior and licenses can change; versions and licenses need review before public release.
- `app.py`, `backend/main.py`, `web/src/main.tsx`, and `dj/automix.js` remain large modules with onboarding and regression risk.

## Release Readiness

Private GitHub gate:

- All intended source directories are tracked, especially `backend/`, `web/`, `tests/`, and `scripts/`.
- `./scripts/check.sh` passes after a fresh `npm ci`.
- Secret scan has no findings.
- No local state, media, caches, generated output, or virtual environments are staged.
- README, license, contributing, security, CI, and this handbook are present.

Public open-source gate:

- Legal review of downloader/service-term risks is complete.
- Machine-readable SPDX or CycloneDX SBOM is generated.
- Third-party license inventory is complete for Python, npm, external CLIs, Demucs/Torch, AudioSR, and analyzer dependencies.
- Backend security tests and UI downloader disclaimers are expanded.
- Fresh clone setup is verified on a clean machine.

## Documentation Map

- `README.md`: user-facing overview, setup, checks, and release status.
- `docs/DEVELOPMENT.md`: canonical human development handbook.
- `AGENTS.md`: canonical AI/coding-agent context.
- `docs/OPEN_SOURCE_READINESS_AUDIT.md`: release gates and security notes.
- `docs/SBOM.md`: third-party inventory and SBOM starter.
- `AGENT_HANDOFF.md`: chronological work log; useful history, not canonical documentation.
- `PROJECT_ANALYSIS.md`: historical audit from before the FastAPI/React/security readiness work; keep for context only.
