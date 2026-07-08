# CLAUDE.md

This repo is the Hive MCP server only. The web panel and sync engine live in a
separate repo, `the-master-brain` (`C:\Users\Lucas\Desktop\the-master-brain`) —
don't look for panel UI code here. See [README.md](README.md) for the tool/API
surface and [LIVE_SERVER_STRUCTURE.md](LIVE_SERVER_STRUCTURE.md) for safety rules
(don't run two prod servers against the same Hive root, don't commit `.env`/tokens/logs, etc).

## Runtime topology (Windows)

- Hive server (this repo): plain `node server.js` process, not a Windows service.
  Started/watched by [start-hive.ps1](start-hive.ps1). Listens on `PORT` from `.env`
  (currently 3939) — liveness check: `GET /api/ping`.
- cloudflared tunnel: also a plain process (`Get-Process cloudflared`), not a service.
- Web panel (`the-master-brain`): runs as an NSSM Windows service, `MasterBrainPanel`,
  on port 4000. Restart with `Restart-Service -Name MasterBrainPanel -Force`.
  **Known bug:** NSSM's stop acknowledges without cleanly killing the headless Node
  child, so the panel's own Stop/Restart buttons are unreliable — restart the
  Windows service directly instead.

## PowerShell from the Bash tool

Bare `powershell`/`powershell.exe` is not reliable here — invoke via full path:
`/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "..."`

## Auth model

`/mcp` does not check identity itself — it trusts whatever email **Cloudflare
Access** approves, so the real identity gate lives in Cloudflare's config, not in
this repo. Claude/ChatGPT connectors use dynamic OAuth client registration and get
bounced through Cloudflare Access automatically. The blunt fallback —
`Authorization: Bearer <HIVE_API_KEY>` — skips Cloudflare Access entirely; only use
it when a client can't do OAuth.
