# Security Policy

## Supported Use

This app is designed for trusted local use. The backend binds to loopback by default and protects API/audio routes with a per-run local token. Do not expose the backend to the internet.

Binding to a LAN or non-loopback interface requires `SCDL_GUI_API_TOKEN` and should be limited to a trusted network.

## Reporting

For private repositories, report security issues directly to the repository owner. For public repositories, open a private security advisory if available.

Please include:

- affected version or commit,
- reproduction steps,
- expected and observed behavior,
- whether local file access, token exposure, or arbitrary command execution is involved.

## Sensitive Data

Do not include access tokens, OAuth tokens, cookies, private URLs, local media, SQLite databases, or logs containing command output in issues or PRs.
