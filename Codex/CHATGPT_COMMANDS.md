# ChatGPT Typed Command Map

These are ChatGPT-only typed-text command conventions. Claude already has
its own MCP prompt setup separately.

ChatGPT should map these messages onto Actions:

| Command | Args | Action | Notes |
|---|---|---|---|
| `/server-status` | none | `getServerStatus` | Returns the live Master Brain / Hive / ChatGPT / Claude status report text. |
| `/openfileweb` | `filepath` | `getFileWebLink` | Returns a browser link for one file. |
| `/startup` | `project`, `load_level` | `startupFirestorm` | Defaults load to `med`. Accepts `light/normal/full`. |
| `/list` | `subpath` | `listFolder` | Omit `subpath` for root. |
| `/read` | `filepath` | `readFile` | Text files only. |
| `/search` | `query`, `subpath` | `searchFiles` | Text-content search. Omit `subpath` for root. |
| `/stat` | `filepath` | `statFile` | Returns size, mtime, and sha256. |
| `/move` | `from`, `to` | `moveFile` | Admin command. Confirm exact paths first. |
| `/mkdir` | `subpath` | `createFolder` | Admin command. Confirm exact path first. |
| `/trash` | `filepath` | `moveToTrash` | Admin command. Prefer over hard delete. |
| `/sort` | none | `previewSortInbox` then `applySortInbox` | Preview first. Never auto-apply. |
| `/emptybin` | none | `emptyTrash` | High-risk. Confirm first. |

Deliberately not mapped as quick ChatGPT commands:

- `writeFile` - needs full file content
- `deleteFile` - hard delete, safer to keep `/trash` as the command path
- `uploadFile` - binary upload is not a good typed-text command
- `getTrashConfig` / `setTrashConfig` - admin config, better as explicit Actions
- `getOAuthState` - operational/admin, not a normal user command

