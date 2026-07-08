# mcp-hive-server

MCP server exposing a folder (`HIVE_ROOT`) as a tool-accessible file store,
authenticated via a static API key or Cloudflare Access OAuth.

## MCP tools

- `list_files`, `read_file`, `write_file`, `delete_file` — basic file CRUD (`delete_file` removes folders recursively too).
- `move_file` — move/rename a file or folder.
- `mkdir` — create a folder.
- `stat_file` — size, modified time, and sha256 of a file.
- `search_files` — substring search across file contents.
- `fetch_url_to_file` — download a URL's content into the store (capped at 10MB).
- `preview_sort_inbox` / `apply_sort_inbox` — drop files/folders into a `_sorter`
  staging folder, `preview_sort_inbox` asks Claude (`ANTHROPIC_API_KEY`) where
  each item should go without moving anything, `apply_sort_inbox` moves only
  the item/destination pairs explicitly confirmed by the caller.

## REST API (`/api/*`)

Same auth as `/mcp` (`Authorization: Bearer <HIVE_API_KEY>` or a valid OAuth
JWT). Used by [the-master-brain](https://github.com/lucaskerim123/the-master-brain)
panel/sync engine, but usable from anything else too:

- `GET /api/ping` — unauthenticated liveness check.
- `GET /api/manifest` — `{ path, size, mtime, sha256 }` for every file, for sync diffing.
- `GET /api/files?subpath=` — list a folder (with per-file size/mtime).
- `GET /api/file?path=` — read a file.
- `PUT /api/file` — `{ path, content }`, create/overwrite a file.
- `DELETE /api/file?path=` — delete a file or folder.
- `POST /api/move` — `{ from, to }`, move/rename a file or folder.
- `POST /api/mkdir` — `{ path }`, create a folder.
- `GET /api/download?path=` — download a file's raw bytes.
- `POST /api/upload?path=` — raw body upload, any content-type.
- `GET /api/oauth-state` — connected MCP clients (Claude/ChatGPT) and accounts with a refresh token, no secrets.
- `POST /api/sort/preview` / `POST /api/sort/apply` — same two-step sort as the MCP tools above, for the web panel's Sort button.

## Logging

Every MCP tool call, REST request, and file change is written as structured
JSON to `logs/master-hive-events.jsonl` (and `-errors.jsonl` on failure),
tagged with which flow it came from (`claude`, `chatgpt`, or `webpanel` via
the `X-Hive-Flow` header, or a raw API key call). The web panel's System tab
reads these for the connection monitor and activity log.

## Running a second instance (e.g. on a VPS)

This same server can run anywhere — point `HIVE_ROOT` at a different folder
and give it its own `PORT` / `HIVE_API_KEY`. That's how
`the-master-brain` treats "PC node" and "VPS node" as two independent
instances of this same codebase, kept in sync by its own sync engine rather
than by anything in this repo.
