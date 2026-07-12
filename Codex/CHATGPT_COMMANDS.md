# ChatGPT Typed Command Map

These are ChatGPT-only typed-text command conventions. Claude already has
its own MCP prompt setup separately.

ChatGPT should map these messages onto Actions:

| Trigger | Args | Action | Notes |
|---|---|---|---|
| `/server-status` | none | `getServerStatus` | Exact hard trigger. Return `text` exactly. |
| `server status` | none | `getServerStatus` | Plain-English hard trigger. |
| `show server status` | none | `getServerStatus` | Plain-English hard trigger. |
| `show hive status` | none | `getServerStatus` | Plain-English hard trigger. |
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

Attachment rule:

- If the user wants to save/upload a binary attachment from ChatGPT and the file only exists as a ChatGPT sandbox attachment/path such as `/mnt/data/...`, do not try `uploadFile`.
- Call `create_upload_link` instead and send the link immediately.
