# OrbitFS ChatGPT Commands

This is the authoritative slash-command list exposed by the live OrbitFS MCP server. Run `/orbithelp` to open the searchable command UI.

| Command | Usage | Description |
|---|---|---|
| `/orbithelp` | `/orbithelp` | Open the separate OrbitFS command help window. |
| `/showcp` | `/showcp` | Open the main OrbitFS control panel on Startup. |
| `/context` | `/context` | Open the main OrbitFS control panel on Context. |
| `/files` | `/files` | Open the main OrbitFS control panel on Files. |
| `/vent` | `/vent` | Open the main OrbitFS control panel on Vent. |
| `/journal` | `/journal` | Open the main OrbitFS control panel on Journal. |
| `/server-status` | `/server-status` | Return the live OrbitFS server, panel, cloud and Sorter status. |
| `/startup` | `/startup [project] [loadstrength]` | Open the startup chooser, or load 1. Legal / 2. Wellbeing using low, medium, high, custom1 or custom2. |
| `/loadfile` | `/loadfile <filepath>` | Load one complete text or DOCX file into active context. |
| `/list` | `/list [subpath]` | List files and folders at the root or inside a folder. |
| `/read` | `/read <filepath>` | Read a text file by its OrbitFS-relative path. |
| `/viewfile` | `/viewfile <filepath>` | Open a PDF, DOCX or text file in the expandable viewer. |
| `/previewfile` | `/previewfile <filepath>` | Open a compact preview of a PDF, DOCX or text file. |
| `/search` | `/search <query> [subpath]` | Search text content, optionally inside one folder. |
| `/stat` | `/stat <filepath>` | Show file size, modified time and SHA-256 hash. |
| `/openfileweb` | `/openfileweb <filepath>` | Create a browser link for a file. The link expires after 15 minutes. |
| `/move` | `/move <source> <destination_folder> [new_name]` | Resolve and preview a move. The exact paths must be confirmed before execution. |
| `/mkdir` | `/mkdir <subpath>` | Create a new folder at the supplied relative path. |
| `/trash` | `/trash <filepath>` | Move a file or folder into _trash instead of hard deleting it. |
| `/emptybin` | `/emptybin` | Permanently empty _trash after listing and explicit confirmation. |
| `/ventmode` | `/ventmode <on|off>` | Turn Pure Private Vent Mode on or off. |
| `/styleentry` | `/styleentry <text> <title> [entry_date]` | Save the final Vent draft. Entry date uses DD-MM-YYYY when provided. |
| `/uploadvent` | `/uploadvent` | Upload the exact saved Vent draft without another confirmation. |

## Verification

- Every command above is registered as an MCP prompt.
- Every generated prompt targets a tool present in the live MCP tool list.
- `/showcp` calls the direct `showcp` UI tool.
- `/orbithelp` calls the separate `orbitfs_help` UI tool.
- `/startup` uses the live `startup` tool and `loadstrength` argument.
- `/styleentry` uses the live `save_vent_draft` tool.
- Sorter is controlled through the OrbitFS Panel; there is no verified ChatGPT `/sort` command in this list.
