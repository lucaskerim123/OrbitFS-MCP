# orbitfs-mcp-server

MCP and REST server for the Master Hive file store.

It exposes the FireStorm root at `HIVE_ROOT` over:

- `POST /mcp` for Claude and ChatGPT MCP clients
- `GET /api/*` and `POST /api/*` for the OrbitFS web panel

The sorter is panel-owned now. This repo no longer carries its own sorter
plugin; use `orbitfs-panel/plugins/OrbitFS Sorter`.

## What it serves

- Shared FireStorm content at `C:\Project FireStorm\The Master Hive`
- Protected system roots like `_system`, `0. Core Folder`, `_media`, and the other project roots
- `_trash` as the soft-delete bin
- `/emptybin`-style permanent deletion for trash contents
- `preview_sort_inbox` / `apply_sort_inbox` for `_sorter`

## Main files

- `server.js` - HTTP server, MCP tools, REST routes, trash workflow
- `hive-ops.js` - filesystem helpers and path safety
- `oauth.js` - OAuth registration and state tracking
- `Codex/` - ChatGPT Actions schemas and startup command docs
- `claude/` - Claude lane notes
- `plugins/README.md` - placeholder note explaining why this repo's `plugins/` folder is intentionally empty

## Environment

Required:

- `HIVE_ROOT`
- `HIVE_API_KEY`
- `PUBLIC_BASE_URL`
- `SESSION_SECRET`

Common optional values:

- `PORT`
- `TRASH_RETENTION_DAYS`

## Run

```powershell
npm install
npm start
```

For local dev, `node server.js` also works.

Setting up on a brand new machine (fresh VPS, etc.)? Copy `.env.example` to
`.env` and fill in the values, or use `orbitfs-panel`'s
`deploy/Install-OrbitFS.ps1`, which asks where you want everything
installed, creates the `HIVE_ROOT` folder skeleton there, generates `.env`
for this repo, and runs `npm install` in one step. Full walkthrough:
`orbitfs-panel/GETTING_STARTED.md`.

## API summary

- `GET /api/ping` - liveness
- `GET /api/manifest` - file manifest for sync and audit
- `GET /api/files?subpath=` - list a folder
- `GET /api/files/recursive?path=` - recursively list a folder tree
- `POST /api/files/read-batch` - batch-read individual text files
- `GET /api/export-folder-link?path=` - create a 15-minute folder ZIP link
- `GET /api/file?path=` - read a file
- `PUT /api/file` - write a file
- `DELETE /api/file?path=` - delete a file or folder, except protected roots
- `POST /api/trash` - move a file or folder into `_trash`
- `POST /api/trash/empty` - permanently empty `_trash`
- `GET /api/trash/config` / `POST /api/trash/config` - admin trash retention
- `POST /api/move` - move/rename
- `POST /api/mkdir` - create a folder
- `GET /api/download?path=` - download raw bytes
- `GET /download-temp?path=&token=` - token-scoped temporary file download or folder ZIP
- `GET /api/open-link?path=` - get a link that opens a file directly in a browser tab (`/openfileweb <file>`, 15-minute expiry)
- `POST /api/upload?path=` - upload raw bytes
- `GET /api/oauth-state` - connected MCP clients and refresh-token accounts
- `POST /api/sort/preview` / `POST /api/sort/apply` - two-step sort workflow

## MCP folder/context tools

- `read_folder_recursive` - recursively list a folder tree
- `read_file` - read one text file
- `read_files_batch` - read up to 50 text files per call with bounded output
- `export_folder` - return a temporary ZIP download link for a folder
- `create_temporary_download_link` - return a temporary link for a file or folder

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

- Deleting from the panel now moves items to `_trash` instead of hard deleting them.
- Protected root folders are intentionally non-deletable and non-trashable.
- Trash is auto-purged after the configured retention window, default `4` days.
- All tool calls, REST requests, and file changes are logged in `logs/`.

