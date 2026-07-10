# Hive Addon Sorter

Optional 4th service for the Master Hive stack. Scans the `_sorter` intake
folder, suggests a destination for each item by matching it against the
*live* Master Hive folder tree, and only moves files once you review and
confirm — nothing is moved during preview.

It's a plugin, not a dependency: the Hive server and panel both work fine
with this service stopped or never started. The panel's System tab detects
whether it's running (`/api/sorter-available`) and shows/hides the Sorter
controls accordingly.

## How it works

1. **Scan inbox** (`POST /api/startsorter`) — rescans the Hive folder tree,
   rebuilds `_system/Index/folder_index.json`, and classifies each file in
   `_sorter` by matching its name/path against a small set of rules (see
   [ADDON_SORTER_RULES.md](ADDON_SORTER_RULES.md)). Nothing moves yet.
2. **Review** — approve/reject each suggestion in the UI, or edit the
   destination path directly.
3. **Confirm & move** (`POST /api/confirmsorter`) — moves only the approved
   items. Anything unapproved, missing a destination, or pointing at
   `_sorter`/`_trash` is skipped.

See [FOLDER_INDEX_SYSTEM.md](FOLDER_INDEX_SYSTEM.md) for how destination
suggestions are resolved against the live tree.

## Running it

```powershell
npm install   # no dependencies today, but keeps this future-proof
npm start
```

Config lives in `config.json`:

| Field | Meaning |
|---|---|
| `port` | HTTP port (default `4055`) |
| `hiveRoot` | Path to the Master Hive folder — must match the Hive server's `HIVE_ROOT` |
| `indexPath` | Where the folder index gets written, relative to `hiveRoot` |
| `sorterFolder` / `trashFolder` | Names of the intake and trash folders (excluded from destination suggestions) |
| `apiKey` | Bearer token required on `/api/*` routes. Leave blank to disable auth (matches the Hive server's `HIVE_API_KEY` if you want single sign-on from the panel) |

`start-addon-sorter.bat` / `stop-addon-sorter.bat` wrap this for manual
start/stop on Windows. The panel's System tab can also start/stop/restart
it directly once it's registered as a service.

## UI

Served at `http://localhost:<port>/` (proxied at `/sorter` behind the
Cloudflare tunnel in front of the panel). Same visual language as the main
panel — same color tokens, same button/card styles — so it doesn't read as
a separate debug tool. Has a "← Back to Master Brain" link back to the main
panel.

## Safety

- Never moves anything during preview — only `/confirmsorter` writes to disk.
- Skips any item without `approved: true`.
- Skips any destination inside `_sorter` or `_trash`.
- If the destination already exists, appends `(1)`, `(2)`, etc. rather than overwriting.
