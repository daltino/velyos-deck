<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/velyos-logo-dark.svg">
    <img alt="VELYOS" src="docs/assets/velyos-logo.svg" width="220">
  </picture>
</p>

<h1 align="center">Velyos Deck</h1>
<p align="center"><strong>An open-source DJ workstation</strong> — by <a href="https://github.com/VELYOS-AI">VELYOS</a></p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-lightgrey.svg">
  <img alt="Status: beta" src="https://img.shields.io/badge/status-beta-orange.svg">
</p>

Velyos Deck is a local, browser-based DJ workstation for building and curating a
music library from **your own files**, analyzing tracks for harmonic mixing, and
performing live with a full dual-deck console — including MIDI controller support,
AI-assisted automixing, and stem separation.

It runs entirely on your machine. It is not a hosted service and must not be
exposed to the internet.

## Features

- **Dual-deck DJ console** in the browser: Web Audio playback, 3-band EQ, morphing
  filter, echo/reverb/gate FX, crossfader, pitch/tempo, BPM sync with phase align.
- **Loops & cues**: 1/4–16 bar auto-loops with slip mode, 8 hot cues per deck.
- **Waveforms**: overview + zoomed beat-grid view, click-to-seek.
- **AutoMix**: harmonic (Camelot) transition planning with BPM matching and
  drop-aware gating.
- **Coach**: live guidance on energy, key compatibility, and structure.
- **Generative deck**: in-browser synthesized drum/bass/fill layers.
- **MIDI**: native support for the Pioneer DDJ-SB3 (with LED feedback) plus WebMIDI
  and full keyboard control.
- **Library**: local SQLite library with search/filter by BPM, key, Camelot, energy.
- **Club Master enhancement**: 48 kHz / 24-bit loudness-managed master rendering.
- **Optional (experimental)**: BPM/key/Camelot analysis, stem separation (Demucs),
  audio super-resolution (AudioSR), Shazam identification — see [docs/MODELS.md](docs/MODELS.md).

> Velyos Deck works with audio files **you already own or are licensed to use**.
> It does not download from streaming platforms. See
> [docs/USER_RESPONSIBILITIES.md](docs/USER_RESPONSIBILITIES.md).

## Requirements

- macOS (for the Finder picker and native CoreMIDI).
- Python 3.11 or newer.
- Node.js 20 with npm 10.
- `ffmpeg` on `PATH`.

## Quick start

```bash
./run.sh
```

The launcher finds a usable Python, creates the `.venv`, installs dependencies,
builds the web UI, and starts the backend at `http://127.0.0.1` with a per-run
local API token. To bind outside loopback you must set `SCDL_GUI_API_TOKEN`.

Manual / development steps and the optional analyzer setup are documented in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and the section below.

### Optional: analyzer & stem-separation features

These optional features run from a separate Python 3.11 environment so their heavy
dependencies stay isolated. The app runs fine without them.

```bash
./scripts/setup-analyzer.sh            # librosa, numpy, shazamio
./scripts/setup-analyzer.sh --demucs   # + Demucs/Torch stem separation
./scripts/setup-analyzer.sh --all      # + AudioSR super-resolution
```

### Entry points

`python -m backend.main` (via `./run.sh`) is the single supported way to run Velyos
Deck. `app.py` (legacy Tkinter UI), `dj_server.py`, and `phone_server.py` are
legacy/auxiliary and are not the primary path.

## Open core

Velyos Deck's core is free and open source under the AGPL. VELYOS plans a paid
**Velyos Pro** layer for hardened/hosted extras.

| Free core (AGPL-3.0) | Velyos Pro (planned) |
|---|---|
| DJ deck, EQ/FX/loops/cues | Cloud stem separation |
| AutoMix + Coach | AI automix "pro" presets |
| Library + harmonic analysis of local files | Library sync across devices |
| Club Master enhancement | Curated preset/content packs |

See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for dual-licensing.

## Data and local files

Runtime state is stored under `~/.music-dl-gui` by default. Databases, media,
stems, enhanced audio, build outputs, caches, virtual environments, and `.env`
files are git-ignored. Useful env vars: `SCDL_GUI_DATA_DIR`, `SCDL_GUI_PORT`,
`SCDL_GUI_API_TOKEN`.

## Checks

```bash
./scripts/check.sh
```

Compiles Python, validates DJ JavaScript, runs Node tests, runs the web
typecheck/build, and checks whitespace.

## Documentation

- [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) — what works today, verified.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — developer handbook.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- [SECURITY.md](SECURITY.md) — local-only security model.
- [docs/SBOM.md](docs/SBOM.md), [docs/MODELS.md](docs/MODELS.md),
  [docs/USER_RESPONSIBILITIES.md](docs/USER_RESPONSIBILITIES.md).
- [AGENTS.md](AGENTS.md) — context for AI/coding agents.

## License

Velyos Deck is licensed under the **GNU AGPL-3.0-only** — see [LICENSE](LICENSE).
A separate commercial license is available — see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

© 2026 VELYOS / Štěpán Manda.
