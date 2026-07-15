# CLAUDE.md

This repo is the **OrbitFS MCP server** only (internal MCP name `orbitfs`; was
"Master Hive"). The web panel and sync engine live in a separate repo,
**`orbitfs-panel`** (`F:\OrbitFS Project\orbitfs-panel`) — don't look for panel UI code here.
See [README.md](README.md) for the tool/API surface and
[LIVE_SERVER_STRUCTURE.md](LIVE_SERVER_STRUCTURE.md) for safety rules (don't run
two prod servers against the same HIVE_ROOT, don't commit `.env`/tokens/logs).

## Runtime topology (Windows) — all NSSM services (renamed 2026-07-12)

| Role | Service | Dir | Port | StartType |
|------|---------|-----|------|-----------|
| MCP server (this repo) | **OrbitFSMcpServer** | F:\OrbitFS Project\orbitfs-mcp | 3939 | Manual |
| Web panel (orbitfs-panel repo) | **OrbitFSPanel** | F:\OrbitFS Project\orbitfs-panel | 4000 | Automatic |
| Addon sorter | **OrbitFSSorter** | F:\OrbitFS Project\orbitfs-panel\plugins\OrbitFS Sorter | 4055 (auto) | Manual |
| Cloudflare tunnel | **OrbitFSTunnel** | C:\cloudflared | — | Automatic |

- Restart any of them via the Windows service, e.g.
  `Restart-Service OrbitFSMcpServer -Force`. Liveness: `GET /api/ping` returns
  `{"ok":true,"name":"orbitfs"}`.
- **NSSM child-kill bug:** NSSM's stop acknowledges without cleanly killing the
  headless Node child, so restarts can race a still-dying process. If a restart
  fails, check for a lingering `node server.js` (or a shell/watcher sitting in
  the dir) before retrying.
  Reliable restart recipe: `Stop-Service -Force` → kill any leftover
  `node.exe` whose CommandLine matches `server.js` (exclude Panel) → confirm
  zero via `Get-CimInstance Win32_Process` → `Start-Service` → verify with
  `Get-NetTCPConnection -LocalPort <port>` (or `netstat -ano | grep LISTENING`),
  not `Get-Service` status alone — status can say "Running" while a stale
  process still squats the port or a fresh one hasn't bound yet.
- Boot policy: only **OrbitFSPanel** + **OrbitFSTunnel** auto-start. The MCP
  server and sorter are Manual — started on demand from the panel's System tab.
- The cloudflared tunnel is **remote-managed** (routes live in the Cloudflare
  dashboard); a local `config.yml` ingress is ignored. Do NOT have any service
  rewrite it or `taskkill` cloudflared — that fights the OrbitFSTunnel service.
- This repo does **not** contain a local sorter anymore. Any sorter mention in
  this repo points at `orbitfs-panel/plugins/OrbitFS Sorter`.

## Everything runs off config

- MCP server: all config from `.env` (HIVE_ROOT, PORT, PUBLIC_BASE_URL,
  HIVE_API_KEY, SESSION_SECRET, UPLOAD_MAX_MB, service-name overrides for the
  panel/tunnel it monitors — defaults are the OrbitFS* names).
- Sorter: its own `.env` plus legacy `config.json` fallback (port, hive root,
  folders, API key).
- Panel: `.env` (PANEL_PORT, HIVE_URL/KEY, all *_SERVICE_NAME, HIVE_SERVER_DIR,
  SORTER_DIR, CLOUDFLARED_*). The panel proxies the sorter at `/api/sorter/*`
  and reads `<SORTER_DIR>/.sorter-port` to find its live port.

## Kept names (NOT renamed in the OrbitFS rebrand)

- Project name **"FireStorm"** and the data folder **"The Master Hive"**
  (`HIVE_ROOT`) stay as-is.
- Public domains stay: `hive.` / `brain.` / `sorter.incendiarynetworks.cc`.
- The cloudflared tunnel's internal name is still `master-hive` (CF-side id tied
  to the tunnel UUID/credentials).

## Key files

- `hive-ops.js` — shared file-op logic used by both MCP tools and REST routes in
  `server.js`: enforces paths can't escape `HIVE_ROOT` (`safeResolve`), detects
  UTF-16/UTF-8 BOMs, and `appendFile` backs chunked uploads.
- File-writing tools (`upload_file`, `write_file`, `fetch_url_to_file`) default a
  bare filename (no folder) into `_sorter`; an explicit folder path is honored.
  `upload_file` supports chunked base64 via `append=true`.

## PowerShell from the Bash tool

Bare `powershell`/`powershell.exe` is not reliable here — invoke via full path:
`/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "..."`.
Never use PowerShell redirect syntax (`*>`) inside a bash command — bash
glob-expands the `*`. Use `2>/dev/null` / `| Out-Null` inside the PS string.
`Get-CimInstance -Filter` chokes on combined `LIKE ... AND ... NOTLIKE ...`
("Invalid query"). Fetch broadly and filter with `Where-Object` in the
pipeline instead.

## Claude widget bridge (app/widget/)

Widget assembled at server startup from `shell.html` (markup/CSS) +
`core.js` (host-agnostic UI logic) + `bridge.chatgpt.js` / `bridge.claude.js`
(per-host `window.OrbitFSBridge` implementation) + the inlined
`@modelcontextprotocol/ext-apps` bundle — see `assembleWidget()` in
`server.js`. Editing `app/widget/index.html` directly does nothing; it no
longer exists.

**Gotcha:** `app.callServerTool()` (widget → server) is silent — the model
never sees the result. Tool responses meant to be read by the model use
`[INTERNAL ...]` / `[ORBITFS CONTEXT UPDATE]` framing text (grep for it);
any tool using that framing must also be in `bridge.claude.js`'s
`CONTEXT_SYNC_TOOLS` set, which forwards the result via
`app.updateModelContext()`. Forgetting this makes a button look like it
works (widget UI updates) while the model stays completely unaware.

## Auth model

`/mcp` does not check identity itself — it trusts whatever email **Cloudflare
Access** approves, so the real identity gate lives in Cloudflare's config, not in
this repo. Claude/ChatGPT connectors use dynamic OAuth client registration and get
bounced through Cloudflare Access automatically. The blunt fallback —
`Authorization: Bearer <HIVE_API_KEY>` — skips Cloudflare Access entirely; only use
it when a client can't do OAuth.
