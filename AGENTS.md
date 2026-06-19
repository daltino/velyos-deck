# AI Development Context

This is the primary context file for AI/coding agents working in this repository.

## Read First

1. `README.md` for user-facing purpose, setup, and release status.
2. `docs/DEVELOPMENT.md` for canonical current architecture, completed features, security model, and verification.
3. `docs/OPEN_SOURCE_READINESS_AUDIT.md` for private/public release gates.
4. `AGENT_HANDOFF.md` for chronological implementation history only.

`PROJECT_ANALYSIS.md` is historical and partially superseded by the FastAPI/React/backend security work.

## Project State

Velyos Deck is a local-first macOS DJ workstation: a browser DJ deck, track analyzer, enhancer, and library manager that works on the user's own audio files. The streaming downloader is **excluded from the public release** (legal/brand risk) and lives in a gitignored local-only module — see `docs/FEATURE_STATUS.md`.

Current implemented surfaces:

- Legacy Tkinter app: `app.py` — **gitignored, excluded from the public release**; not used by the backend.
- FastAPI backend: `backend/main.py` (uses `backend/dj_core.py` for local-only audio helpers).
- React/Vite web UI: `web/`.
- Vanilla browser DJ deck: `dj/`.
- DJ HTTP server: `dj_server.py`.
- MIDI bridge: `midi_bridge.py`.
- Phone/LAN proxy: `phone_server.py`.
- Checks: `scripts/check.sh`, GitHub Actions, Node tests in `tests/`.

The repository currently contains many uncommitted and untracked files. Treat them as user work. Do not revert, reset, or clean them unless explicitly instructed.

## Working Rules

- Preserve local-first security. Do not expose services beyond loopback unless the user explicitly requests it and `SCDL_GUI_API_TOKEN` is handled.
- Do not commit or stage local media, SQLite state, `.env` files, tokens, cookies, private URLs, generated stems/enhanced audio, virtual environments, `node_modules`, or `web/dist`.
- Do not add streaming-platform download features to the public project; that is intentionally excluded (legal/brand). The public app works on the user's own local files. See `docs/USER_RESPONSIBILITIES.md`.
- Prefer existing project patterns over new frameworks.
- Use `rg`/`rg --files` for searches.
- Use `apply_patch` for manual file edits.
- Avoid broad refactors unless directly required.

## Architecture Notes

- `backend/main.py` owns SQLite state, protected API routes, job lifecycle, quality/similar lookup jobs, local token bootstrap, secret redaction, allowed-root filesystem checks, and built React serving.
- `web/src/main.tsx` is the current React UI entrypoint and sends `X-SCDL-GUI-Token` after reading `/api/client-config`.
- The backend imports `backend/dj_core.py` (local-file analysis/stems/enhance helpers) and, optionally, a gitignored `downloader_local.py` (streaming download + online discovery). When the latter is absent the download/quality/similar features degrade gracefully and the nav items are hidden. `app.py` is no longer imported by the backend.
- `dj/*.js` is not bundled by Vite; it is a separate browser DJ app.
- `/library.json`, `/audio`, `/prepare`, `/sets`, `/runtime.json`, `/stems`, and `/export` preserve DJ compatibility behavior.
- `phone_server.py` is intentionally LAN-facing and should be treated as trusted-LAN-only.

## Verification

Run the standard check after code changes:

```bash
./scripts/check.sh
```

Before release or handoff, also run:

```bash
git diff --check
git status --short
```

Also run the secret smoke scan from `.github/workflows/ci.yml`; do not paste secrets or scan-hit output into docs, issues, or handoff notes.

`scripts/check.sh` requires `web/node_modules`; run `cd web && npm ci` if needed. The project declares Node.js 20/npm 10 for reproducible builds.

## Known Gaps

- Public open-source release still needs legal review for downloader workflows and platform terms.
- SBOM and third-party license inventory are starters, not complete release artifacts.
- Backend pytest coverage is still missing for token enforcement, settings redaction, allowed roots, audio Range, and job lifecycle.
- UI tests are still missing for Enhance and Jobs workflows.
- Large modules remain: `app.py`, `backend/main.py`, `web/src/main.tsx`, and `dj/automix.js`.
- Phone/LAN proxy still needs optional PIN/token before use on untrusted networks.

## Current Release Gates

Private GitHub:

- Track all intended source directories.
- Ensure `./scripts/check.sh` passes from a fresh clone after `npm ci`.
- Confirm no secrets, local media, SQLite data, virtualenvs, or build output are staged.

Public open-source:

- Complete legal review.
- Complete SBOM/license inventory.
- Expand security tests and downloader UI disclaimers.
- Verify fresh clone setup on a clean machine.
