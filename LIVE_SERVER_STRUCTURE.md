# Master Hive MCP Live Server Structure

This folder is the live MCP server for both ChatGPT and Claude.

## Live Server

- Path: `C:\mcp-hive-server`
- Process entrypoint: `server.js`
- Environment file: `.env`
- OAuth state file: `oauth_state.json`
- MCP endpoint: `${PUBLIC_BASE_URL}/mcp`
- OAuth discovery:
  - `${PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`
  - `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`

## Client Layout

Use one server and separate OAuth client registrations:

- ChatGPT client:
  - Local lane folder: `C:\mcp-hive-server\Codex`
  - Redirect URI starts with `https://chatgpt.com/connector/oauth/`
  - Uses the shared MCP endpoint: `${PUBLIC_BASE_URL}/mcp`

- Claude client:
  - Local lane folder: `C:\mcp-hive-server\claude`
  - Redirect URI is `https://claude.ai/api/mcp/auth_callback`
  - Uses the shared MCP endpoint: `${PUBLIC_BASE_URL}/mcp`

Both clients use the same tool schema and the same Master Hive root. Client-specific behavior should live in the client prompt/configuration, not in duplicated MCP servers.

## What Belongs Where

- Shared MCP tools: `server.js`
- OAuth flow and client registration handling: `oauth.js`
- Registered OAuth clients and refresh tokens: `oauth_state.json`
- Runtime secrets and deployment URLs: `.env`
- Service startup wrapper: `start-hive.ps1`
- Runtime logs: `*.log`
- ChatGPT/Codex-specific connection notes: `Codex\`
- Claude-specific connection notes: `claude\`

## Safety Rules

- Do not run two production servers against the same Hive root.
- Do not edit Hive content files from this repo.
- Do not put ChatGPT or Claude instruction text in this repo.
- Do not commit `.env`, OAuth tokens, or logs.
- Test risky changes in a separate copy, then merge only the reviewed diff into this live folder.

## Current Cleanup Notes

`oauth_state.json` may contain old or duplicate registrations after reconnecting clients. That is normal during setup, but cleanup should be done deliberately:

- Keep the active ChatGPT registration.
- Keep the active Claude registration.
- Remove only confirmed stale registrations.
- Never remove refresh tokens unless you intend to force that client/user to re-authenticate.
