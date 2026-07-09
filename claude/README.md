# Claude Client Lane

This folder contains Claude-specific notes for the shared Hive connection.

The MCP server is still shared:

- Live server folder: `C:\mcp-hive-server`
- MCP endpoint: `${PUBLIC_BASE_URL}/mcp`
- Tool implementation: `..\server.js`
- OAuth implementation: `..\oauth.js`

Keep only Claude client notes here. Do not put Hive content files or Claude instruction files in this folder.

## Scope

- Claude and ChatGPT both use the same Hive server
- File content lives in `C:\Project FireStorm\The Master Hive`
- Protected roots and trash behavior are enforced by the server, not by the client

## Slash commands

`/openfileweb`, `/startup`, and `/emptybin` are real MCP prompts
(`server.prompt(...)` in `server.js`), so Claude lists and autocompletes
them as actual slash commands - no custom instructions needed on the
Claude side, unlike the ChatGPT lane in `Codex/`. `/startup` takes a
project name (Master, Court, Mental, Media, or combined with `:`) - there
are no separate per-project shortcut commands.
