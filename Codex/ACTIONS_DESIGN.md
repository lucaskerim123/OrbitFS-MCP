# ChatGPT Actions Design

## Goal

Give ChatGPT a clear Actions lane without changing the shared MCP tools used by Claude.

ChatGPT Actions should call the existing REST API exposed by the live server. Claude should continue using MCP tools. Both lanes still point at the same Master Hive root.

## Recommended Rollout

Start with read-only Actions only:

- `pingHive` - health check.
- `listFolder` - list one folder.
- `readFile` - read one text file.
- `getManifest` - get the file manifest for sync/audit context.

Do not enable write, delete, move, mkdir, upload, or download Actions in the first pass.

## Why Read-Only First

Read-only Actions let ChatGPT inspect the Hive without risking accidental edits. Any destructive or mutating workflow can stay in MCP/server code until it has explicit guardrails.

## Authentication

Use the live server's existing bearer auth.

For ChatGPT Actions, configure authentication as API key / bearer token:

- Header name: `Authorization`
- Header value shape: `Bearer <HIVE_API_KEY>`

Do not put the API key in any repo file.

## Action Boundary

ChatGPT Actions lane:

- OpenAPI schemas live here in `C:\mcp-hive-server\Codex`.
- Actions call REST endpoints under `/api`.
- Actions should be small, obvious, and low-risk.

Shared server lane:

- Real server code stays in `C:\mcp-hive-server\server.js`.
- OAuth stays in `C:\mcp-hive-server\oauth.js`.
- Hive content stays outside this repo.

Claude lane:

- Claude continues to use MCP tools through `/mcp`.
- Claude-specific notes live in `C:\mcp-hive-server\claude`.

## Later Admin Actions

Only add these after the read-only Actions are tested:

- `writeFile`
- `createFolder`
- `moveFile`
- `deleteFile`
- `uploadFile`

Before enabling admin Actions, add a confirmation policy and consider separate auth for admin operations.

## Full Action Catalog

These actions already exist in `master-hive-full.openapi.yaml` because the live server already exposes matching REST endpoints.

Read-only:

- `pingHive` - check whether the Hive server is reachable.
- `listFolder` - list one folder.
- `readFile` - read one text file.
- `getManifest` - get the full file manifest.
- `downloadFile` - download a file through the Hive server.
- `getFileWebLink` - get a link that opens a file directly in a browser tab (`/openfileweb <file>`).
- `getOAuthState` - inspect registered OAuth clients and refresh-token accounts.

Write/admin:

- `writeFile` - create or overwrite a text file.
- `deleteFile` - delete a file or folder.
- `moveToTrash` - move a file or folder into `🗑 Trash` as a soft delete.
- `emptyTrash` - permanently delete everything in `🗑 Trash`.
- `moveFile` - move or rename a file or folder.
- `createFolder` - create a folder.
- `uploadFile` - upload raw file bytes.

Recommended ChatGPT policy:

- Treat `writeFile`, `deleteFile`, `moveFile`, `createFolder`, and `uploadFile` as admin actions.
- Prefer `moveToTrash` over `deleteFile` for normal user-facing deletes.
- Treat `emptyTrash` as a high-risk admin action requiring explicit confirmation.
- Ask the user for explicit confirmation before any admin action.
- Never perform admin actions against instruction files or Hive content unless the user names the exact target path.

## Needed Future Actions

These are useful ChatGPT Actions, but they need new live-server REST endpoints before they can go in the OpenAPI schema.

Search/discovery:

- `searchFiles` - search filenames by query.
- `searchFileContents` - search text contents across files.
- `getFileInfo` - get metadata for one path: type, size, modified time, hash.
- `getFolderTree` - return a recursive tree without file contents.
- `recentFiles` - list recently modified files.

Safety/review:

- `previewWriteFile` - return a diff/preview before overwriting a file.
- `validatePath` - check whether a target path is allowed and whether it exists.
- `checkConflicts` - compare expected file hash/mtime before writing.
- `dryRunMove` - preview move/rename effects.
- `dryRunDelete` - preview delete effects and child count for folders.

Versioning/recovery:

- `createBackup` - copy a target file/folder into a backup location.
- `listBackups` - list backups for a path.
- `restoreBackup` - restore a specific backup.
- `snapshotHive` - create a full lightweight manifest snapshot.
- `compareSnapshots` - show added/changed/deleted paths between snapshots.

Organization:

- `ensureFolder` - create a folder only if missing.
- `batchMove` - move several files in one confirmed operation.
- `batchDelete` - delete several files in one confirmed operation.
- `renameFolder` - explicit folder rename command.
- `normalizePathNames` - detect problematic names, not automatically fix them.

Client-flow/admin:

- `getClientFlows` - return ChatGPT/Codex and Claude registration counts directly.
- `listOAuthClients` - list registered clients with flow classification.
- `revokeOAuthClient` - remove one stale client registration.
- `revokeRefreshToken` - force one account/client to re-authenticate.
- `getServerLogs` - read recent structured logs through a safe endpoint.

Operational:

- `getServerStatus` - return Hive server/tunnel/panel status from the web panel or a shared monitor endpoint.
- `getDiskStatus` - return disk totals/free space.
- `getQueueStatus` - future place for long-running upload/sync jobs.
- `restartHiveServer` - admin-only, probably better kept in the web panel rather than ChatGPT Actions.

Implementation priority:

1. `searchFiles`, `getFileInfo`, `getFolderTree`, `recentFiles`.
2. `previewWriteFile`, `validatePath`, `checkConflicts`.
3. `createBackup`, `listBackups`, `restoreBackup`.
4. `getClientFlows`, `listOAuthClients`, `getServerLogs`.
5. Batch operations only after backup/preview exists.

## Startup Commands

ChatGPT slash-style startup commands are defined in `STARTUP_COMMANDS.md`.

They map user commands such as:

- `/startup Court light`
- `/startup Mental full`
- `/startup Court:Mental normal`

to read-only Action calls that load the real Hive startup files from `_system/Startup`.

Trash/deletion commands are separate:

- moving a file to `🗑 Trash` is a soft delete
- `/emptybin` permanently deletes everything currently in `🗑 Trash`
- anything left in `🗑 Trash` is auto-purged after 4 days by default
- admins can change the auto-purge retention from Master Brain
