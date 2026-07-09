# mcp-hive-server

MCP and REST server for the Master Hive file store.

It exposes the FireStorm root at `HIVE_ROOT` over:

- `POST /mcp` for Claude and ChatGPT MCP clients
- `GET /api/*` and `POST /api/*` for the Master Brain web panel

## What it serves

- Shared FireStorm content at `C:\Project FireStorm\The Master Hive`
- Protected system roots like `_system`, `0. Core Folder`, `Media`, and the other project roots
- `🗑 Trash` as the soft-delete bin
- `/emptybin`-style permanent deletion for trash contents
- `preview_sort_inbox` / `apply_sort_inbox` for `_sorter`

## Main files

- `server.js` - HTTP server, MCP tools, REST routes, trash workflow
- `hive-ops.js` - filesystem helpers and path safety
- `oauth.js` - OAuth registration and state tracking
- `Codex/` - ChatGPT Actions schemas and startup command docs
- `claude/` - Claude lane notes

## Environment

Required:

- `HIVE_ROOT`
- `HIVE_API_KEY`
- `PUBLIC_BASE_URL`
- `SESSION_SECRET`

Common optional values:

- `PORT`
- `ANTHROPIC_API_KEY`
- `SORT_MODEL`
- `TRASH_RETENTION_DAYS`

## Run

```powershell
npm install
npm start
```

For local dev, `node server.js` also works.

Setting up on a brand new machine (fresh VPS, etc.)? Copy `.env.example` to
`.env` and fill in the values, or use `the-master-brain`'s
`deploy/Install-BaseStructure.ps1`, which creates the `HIVE_ROOT` folder
skeleton, generates `.env` for this repo, and runs `npm install` in one
step. Full walkthrough: `the-master-brain/GETTING_STARTED.md`.

## API summary

- `GET /api/ping` - liveness
- `GET /api/manifest` - file manifest for sync and audit
- `GET /api/files?subpath=` - list a folder
- `GET /api/file?path=` - read a file
- `PUT /api/file` - write a file
- `DELETE /api/file?path=` - delete a file or folder, except protected roots
- `POST /api/trash` - move a file or folder into `🗑 Trash`
- `POST /api/trash/empty` - permanently empty `🗑 Trash`
- `GET /api/trash/config` / `POST /api/trash/config` - admin trash retention
- `POST /api/move` - move/rename
- `POST /api/mkdir` - create a folder
- `GET /api/download?path=` - download raw bytes
- `POST /api/upload?path=` - upload raw bytes
- `GET /api/oauth-state` - connected MCP clients and refresh-token accounts
- `POST /api/sort/preview` / `POST /api/sort/apply` - two-step sort workflow

## Notes

- Deleting from the panel now moves items to `🗑 Trash` instead of hard deleting them.
- Protected root folders are intentionally non-deletable and non-trashable.
- Trash is auto-purged after the configured retention window, default `4` days.
- All tool calls, REST requests, and file changes are logged in `logs/`.
