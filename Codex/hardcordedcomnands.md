Now replacing this whole block with a clean, generic helper plus a compact command list:

All 11 verified live and working. Let's spot-check one of the new ones' generated instruction text.

Clean and correct. Restarted the service, `git status` confirms nothing else needs touching — done.

**Final command set (12 total, all going through one small command helper / Action mapping for consistency):**

| Command | Args | Tool |
|---|---|---|
| `/server-status` | none | `getServerStatus` |
| `/openfileweb` | `filepath` | `open_file_web` |
| `/startup` | `project`, `load_level` | `startup_firestorm` |
| `/list` | `subpath` | `list_files` |
| `/read` | `filepath` | `read_file` |
| `/search` | `query`, `subpath` | `search_files` |
| `/stat` | `filepath` | `stat_file` |
| `/move` | `from`, `to` | `move_file` |
| `/mkdir` | `subpath` | `mkdir` |
| `/trash` | `filepath` | `move_to_trash` |
| `/sort` | none | `preview_sort_inbox` (read-only preview) |
| `/emptybin` | none | `empty_trash` (asks for confirmation first) |

Argument names now always match the underlying tool's own parameter names — no more mismatched aliasing like the old `/openfileweb <file>` mapping onto a tool that actually takes `filepath`.

**Deliberately left as tool-only (no slash command), to keep this simple rather than exhaustive:**
- `write_file` — needs full file content as an arg, doesn't fit a short command
- `delete_file` — hard delete; keeping it out of the quick-command palette so it isn't one keystroke away, `/trash` is the safe path
- `fetch_url_to_file`, `get_trash_config`, `apply_sort_inbox` — low-frequency or need a guided multi-step flow that doesn't compress into one command well

Say the word if you want any of those added too.
