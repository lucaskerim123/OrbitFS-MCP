# mcp-hive-server

MCP server exposing a folder (`HIVE_ROOT`) as a tool-accessible file store,
authenticated via a static API key or Cloudflare Access OAuth.

## MCP tools

- `list_files`, `read_file`, `write_file`, `delete_file` — basic file CRUD.
- `move_file` — move/rename a file.
- `mkdir` — create a folder.
- `stat_file` — size, modified time, and sha256 of a file.
- `search_files` — substring search across file contents.
- `fetch_url_to_file` — download a URL's content into the store (capped at 10MB).

## REST API (`/api/*`)

Same auth as `/mcp` (`Authorization: Bearer <HIVE_API_KEY>` or a valid OAuth
JWT). Used by [the-master-brain](https://github.com/lucaskerim123/the-master-brain)
panel/sync engine, but usable from anything else too:

- `GET /api/ping` — unauthenticated liveness check.
- `GET /api/manifest` — `{ path, size, mtime, sha256 }` for every file, for sync diffing.
- `GET /api/files?subpath=` — list a folder.
- `GET /api/file?path=` — read a file.
- `PUT /api/file` — `{ path, content }`, create/overwrite a file.
- `DELETE /api/file?path=` — delete a file.
- `POST /api/move` — `{ from, to }`, move/rename a file.

## Running a second instance (e.g. on a VPS)

This same server can run anywhere — point `HIVE_ROOT` at a different folder
and give it its own `PORT` / `HIVE_API_KEY`. That's how
`the-master-brain` treats "PC node" and "VPS node" as two independent
instances of this same codebase, kept in sync by its own sync engine rather
than by anything in this repo.
