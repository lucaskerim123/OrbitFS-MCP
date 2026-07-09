# mcp-hive-server

MCP and REST server for the Master Hive file store.

It exposes the FireStorm root at `HIVE_ROOT` over:

- `POST /mcp` for Claude and ChatGPT MCP clients
- `GET /api/*` and `POST /api/*` for the Master Brain web panel

## What it serves

- Shared FireStorm content at `C:\Project FireStorm\The Master Hive`
- Protected system roots like `_system`, `0. Core Folder`, `_media`, and the other project roots
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
- `GET /api/open-link?path=` - get a link that opens a file directly in a browser tab (`/openfileweb <file>`, 15-minute expiry)
- `POST /api/upload?path=` - upload raw bytes
- `GET /api/oauth-state` - connected MCP clients and refresh-token accounts
- `POST /api/sort/preview` / `POST /api/sort/apply` - two-step sort workflow

## Slash commands (MCP prompts)

`/openfileweb`, `/startup`, and `/emptybin` are registered as real MCP
prompts (`server.prompt(...)` in `server.js`), not just a text convention
the model has to infer. `/startup` takes a project name (Master, Court,
Mental, Media, or combined with `:` like `Court:Mental`) - there are no
separate per-project shortcut commands. Each prompt seeds a user turn
telling the model which tool to call, so the underlying work still runs
through the normal tools (`open_file_web`, `startup_firestorm`,
`empty_trash`).

Client support is uneven, so what "real slash command" actually gets you
depends on the client:

- **Claude** lists and autocompletes these as real slash commands today -
  confirmed against the live server via `prompts/list`/`prompts/get`.
- **ChatGPT** does not support MCP prompts at all yet, in either lane
  (Developer Mode MCP connector or the legacy Custom GPT/Actions lane) -
  see [openai/codex#8342](https://github.com/openai/codex/issues/8342).
  Registering the prompts here costs nothing and is ready for whenever
  OpenAI ships client support, but for now ChatGPT still needs the
  typed-text convention documented in `Codex/CHATGPT_CUSTOM_INSTRUCTIONS.md`
  (type `/openfileweb <file>` as a normal message; custom instructions tell
  the model to map it onto the `getFileWebLink` Action).

## Notes

- Deleting from the panel now moves items to `🗑 Trash` instead of hard deleting them.
- Protected root folders are intentionally non-deletable and non-trashable.
- Trash is auto-purged after the configured retention window, default `4` days.
- All tool calls, REST requests, and file changes are logged in `logs/`.
