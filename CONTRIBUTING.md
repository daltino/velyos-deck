# Contributing

Thanks for your interest in Velyos Deck. By contributing you agree your work is
licensed under the project's AGPL-3.0 license.

## Development Setup

Use Python 3.11+ and Node.js 20/npm 10. The simplest path:

```bash
./run.sh
```

Or manually:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cd web && npm ci && cd ..
./scripts/check.sh
```

Optional analyzer/stem features: `./scripts/setup-analyzer.sh` (see README).

## Expectations

- Keep the app local-first. Do not introduce hosted-service assumptions without documenting the security impact.
- Do not commit media files, local databases, secrets, virtual environments, or generated build output.
- The public project works on the user's own files. Do **not** add features that download from streaming platforms — that is intentionally out of scope (see `docs/USER_RESPONSIBILITIES.md`).
- Add focused tests for job lifecycle, filesystem/audio access, and frontend polling/cancel flows when changing those areas.
- Document any new external tools, models, APIs, licenses, or data directories.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`
(e.g. `feat(deck): add beat-jump pads`, `fix(api): handle empty library`). Types:
`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`.

## Pull Requests

Before opening a PR:

- Run `./scripts/check.sh` (it must pass).
- Confirm `git status --short` contains only intended source/docs changes.
- Confirm no secrets are present in code, logs, screenshots, or fixtures.
