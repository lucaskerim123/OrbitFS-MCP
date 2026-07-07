# Codex / ChatGPT Client Lane

This folder is for notes and local setup details specific to the ChatGPT/Codex client connection.

The MCP server is still shared:

- Live server folder: `C:\mcp-hive-server`
- MCP endpoint: `${PUBLIC_BASE_URL}/mcp`
- Tool implementation: `..\server.js`
- OAuth implementation: `..\oauth.js`

Keep only client-specific connection notes here. Do not put Hive content files or ChatGPT instruction files in this folder.

## Files

- `ACTIONS_DESIGN.md` - recommended ChatGPT Actions rollout and safety boundaries.
- `master-hive-readonly.openapi.yaml` - read-only OpenAPI schema for ChatGPT Actions.
- `master-hive-full.openapi.yaml` - full read/write/admin OpenAPI schema for ChatGPT Actions.
- `STARTUP_COMMANDS.md` - ChatGPT slash-command map for loading Hive startup files.
