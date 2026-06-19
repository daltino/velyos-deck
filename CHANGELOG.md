# Changelog

## v0.1.0-beta — 2026-06-19

First public beta. Open-source DJ workstation (AGPL-3.0).

- Dual-deck Web Audio console: 3-band EQ, morphing filter, echo/reverb/gate FX, crossfader, tempo/pitch, BPM sync with phase align.
- Beat-synced loops with slip, 8 hot cues per deck, overview + zoom waveforms.
- Harmonic (Camelot) AutoMix planner with drop-aware gating; coach overlay.
- Pioneer DDJ-SB3 MIDI mapping with LED feedback; full keyboard control.
- Local SQLite library with BPM/key/Camelot search; Club Master master rendering.
- Optional (experimental): BPM/key/Camelot analysis, stem separation (Demucs), audio super-resolution (AudioSR) — see `docs/MODELS.md`.
- Backend hardening: per-run API token, loopback-only bind, library-root sandboxing, secret redaction in settings/job history.
- Works only with audio files you already own; streaming-platform downloader intentionally excluded.

### Earlier work folded into this release
- Web Quality and Similar lookups moved onto the backend job system with polling, cancellation, repeat support, and visible errors.
- Complete human and AI development documentation (`docs/DEVELOPMENT.md`, `AGENTS.md`).
- GitHub/open-source readiness docs, templates, CI, and a CycloneDX SBOM (`docs/sbom.json`).
