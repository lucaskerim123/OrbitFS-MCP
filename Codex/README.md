# Codex / ChatGPT Client Lane

This folder contains the ChatGPT/Codex client-side docs for the Hive integration.

The MCP server is still shared:

- Live server folder: `C:\mcp-hive-server`
- MCP endpoint: `${PUBLIC_BASE_URL}/mcp`
- Tool implementation: `..\server.js`
- OAuth implementation: `..\oauth.js`

## Files

- `ACTIONS_DESIGN.md` - ChatGPT Actions rollout and safety boundaries
- `master-hive-readonly.openapi.yaml` - read-only OpenAPI schema for ChatGPT Actions
- `master-hive-full.openapi.yaml` - full read/write/admin OpenAPI schema for ChatGPT Actions
- `CHATGPT_COMMANDS.md` - ChatGPT-only typed command map
- `STARTUP_COMMANDS.md` - `/startup` and `/emptybin` command map for FireStorm
- `CHATGPT_CUSTOM_INSTRUCTIONS.md` - instruction text for ChatGPT typed commands and startup handling

## What this lane does

- Loads FireStorm startup files for Master, Court, Mental, and Media
- Uses the shared Hive REST/MCP server, not a separate data store
- Keeps ChatGPT Actions read-only by default until an admin action is explicitly needed

## Quick setup

1. Point ChatGPT Actions at the read-only OpenAPI schema.
2. Use bearer auth with `HIVE_API_KEY`.
3. Keep `X-Hive-Flow: chatgpt` on the requests so the logs stay readable.
4. If you want admin commands like `/move`, `/mkdir`, `/trash`, `/sort`, and `/emptybin`, switch ChatGPT Actions to the full OpenAPI schema.
5. Paste `CHATGPT_CUSTOM_INSTRUCTIONS.md` into ChatGPT's instruction layer.
6. Use the typed commands from `CHATGPT_COMMANDS.md`, including `/server-status` for live stack status.

