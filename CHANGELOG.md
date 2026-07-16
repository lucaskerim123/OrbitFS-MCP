# Changelog

All notable changes to the OrbitFS MCP server are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Beta 2.0] — 2026-07-16

Since `BetaV1` (2026-07-15).

### Added
- **Licence enforcement**, matching the Panel side — installation-bound key, remote validation, offline grace period, revocation signal poll. See `orbitfs-panel`'s changelog for the shared design.
- **Per-connection MCP role resolution.** Admin connections resolve to unrestricted `owner` access; anyone else needs an active grant, which now scopes them to `member` — read-only browsing and context within their own granted workspace, no Startup/Vent/Journal, no write/upload/delete/move. Denial reasons are now distinguished (no grant vs. disabled workspace vs. unknown identity) instead of a single opaque failure.
- **ChatGPT widget**, split out from the Claude widget into its own bundle (`app/chatgpt-ui/`) with a searchable command-help view.

### Fixed
- **ChatGPT widget showed Startup/Vent/Journal to scoped `member` sessions.** The Claude-side widget already hid these tabs and tools for restricted sessions (`ORBITFS_MCP_ROLE`, `MEMBER_ALLOWED_TOOLS`); the ChatGPT-side bundle never got the same treatment when it was split out — the role was never injected into that resource, there was no CSS to hide the tabs, and the initial-tab logic didn't know restricted mode existed. Brought fully to parity: role injection wired into the ChatGPT widget resource, matching `.orbitfs-restricted` CSS, and `applyInitialView` now defaults a restricted member to the Context tab instead of a hidden Startup tab.
- Stale default public origin (`mcp.incendiarynetworks.cc`, no DNS record) replaced with the correct domain as the code-level fallback, matching the Panel's `.env`.

### Changed
- Removed ~18,000 lines of legacy versioned backup files (`server-core.before-*.js`, `index.before-*.html`, ad hoc test scripts) that had accumulated from manual before/after snapshots during earlier iteration.

### Known / Operational
- Package version (`1.0.0`) hasn't been bumped alongside the Panel's (`2.0.0`) — worth reconciling before tagging a joint release.
- This repo also auto-commits and auto-pushes on every save — see the Panel changelog for the same note.
