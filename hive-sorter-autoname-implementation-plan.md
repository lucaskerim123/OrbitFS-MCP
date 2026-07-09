# Implementation Plan: Sorter Engine, Confirm Flow, and Auto Namer as Real MCP Tools

## Context for whoever/whatever executes this plan

This adds real, server-enforced functionality to the Master Hive MCP server (the one exposing `list_files`, `read_file`, `write_file`, `move_file`, `move_to_trash`, `delete_file`, `mkdir`, `search_files`, `stat_file`, `preview_sort_inbox`, `apply_sort_inbox`, `open_file_web`, `fetch_url_to_file`, `empty_trash`, `get_trash_config`, `startup_firestorm`).

Currently, "/startsorter", "/sortermode", "/autoname" etc. only exist as instructions inside markdown files (`_system/Rules/commands.md` etc.) that Claude/ChatGPT read and follow by convention. Nothing enforces them, nothing persists across sessions or instances, and there's no real state machine. This plan replaces that with actual tools and actual server-side state.

**Step 0, before writing any code: identify the current stack.**
- Find the repo (GitHub) and confirm language/framework (Python+FastMCP, like the HIS server, or Node/TypeScript).
- Find where existing tools (`list_files`, `move_file`, `preview_sort_inbox`, etc.) are implemented, and what storage backend they use (flat files? SQLite? Supabase, given Luke already uses Supabase elsewhere?).
- Reuse that same storage backend and code style rather than introducing a new one. If there's no DB yet and everything is flat-file based, use a single JSON or SQLite file under the server's data directory — do not stand up a new service for this.

If the repo turns out to be Python/FastMCP, follow the mcp-builder Python guide conventions (Pydantic models for inputs, `@mcp.tool` registration, async I/O, actionable error messages). If TypeScript, follow the Node guide conventions (Zod schemas, `server.registerTool`).

---

## 1. Data model

Add persistent storage for three things. A single SQLite table (or three) is simplest if nothing else exists; if Supabase is already wired in for this project, use a Supabase table per entity instead.

### `sorter_settings`
```
active_mode: "ai" | "rules"   (default "ai")
updated_at: timestamp
```
Single row, or key-value.

### `sorter_rules` (only needed if you want rules editable via tool calls rather than a static config file)
```
id
match_type: "extension" | "keyword"
pattern: string          # e.g. ".jpg" or "avo"
destination: string      # folder path
priority: int            # lower = matched first
```
Seed with the same rules already drafted in `_system/Rules/sorter_rules.md`:
- extensions: .jpg/.jpeg/.png/.heic/.gif/.webp → Media/Photos; .mp4/.mov/.avi/.mkv → Media/Videos; .mp3/.wav/.m4a/.aac → Media/Audio
- keywords: avo/charge/bail/ico/cco/court/hearing/callover/call-over → `1. Master Court System/0. Waiting To Be Sorted - Approval Required`; vent/session/mood/journal → `2. Mental Health System/0. Waiting To Be Sorted - Approval Required`; incident → `3. Legal Charges - AVO/Incidents`

### `sorter_proposals`
```
id (uuid)
created_at: timestamp
expires_at: timestamp        # e.g. created_at + 24h, so stale proposals can't be confirmed days later
status: "pending" | "confirmed" | "cancelled" | "expired"
mode_used: "ai" | "rules"
items: JSON array of:
  {
    filename: string,          # original path in _sorter
    destination: string,       # proposed destination folder
    suggested_name: string|null,  # from auto-namer, if filename was flagged generic
    match_reason: string       # e.g. "keyword:avo" or "ai:court-leaning" or "no rule match"
    approved_destination: string   # starts equal to destination, mutated by edits
    approved_name: string|null     # starts equal to suggested_name, mutated by edits
  }
```

This is the critical fix versus the current markdown-only version: the proposal is a real row with a real ID, so it survives across chat turns, sessions, and even different Claude/ChatGPT instances — not just "still in this conversation's context."

---

## 2. New tools to implement

Naming convention: prefix with `hive_` or whatever prefix existing tools use (check step 0) for consistency — e.g. if existing tools are unprefixed (`list_files`), match that instead.

### `get_sorter_mode()`
- Read-only. Returns `{ active_mode }`.

### `set_sorter_mode(mode: "ai" | "rules")`
- Validates mode is one of the two values.
- Writes to `sorter_settings`.
- Returns confirmation `{ active_mode }`.
- Annotation: not destructive, not read-only.

### `preview_sorter()`
- Read-only (does not move/rename anything).
- Reads `active_mode` from `sorter_settings`.
- Lists `_sorter` recursively.
- If empty: return `{ empty: true }`.
- For each file:
  - `mode = "rules"`: match against `sorter_rules` table by priority, first match wins. No match → `match_reason: "no rule match"`, `destination: null`.
  - `mode = "ai"`: this tool cannot do content-judgment classification itself (that requires an LLM). Two options, pick based on what's realistic given the server's capabilities:
    - **Option A (recommended)**: keep AI-mode classification happening in the calling LLM (Claude/ChatGPT), same as today — the tool's job is just to *create and store* the proposal object once the LLM has produced the file→destination list, so it gets a real ID and persists. In this case `preview_sorter` becomes two tools: `classify_hint()` (returns file list + existing `preview_sort_inbox`-style hints for the LLM to reason over) and `create_sorter_proposal(items)` (LLM submits its classification result, tool stores it and returns a proposal ID).
    - **Option B**: call out to the Anthropic API server-side with a classification prompt over each file's content, so mode="ai" is fully server-side too. Only do this if the server already makes outbound LLM calls elsewhere (check step 0) — otherwise this adds real cost/complexity for marginal benefit, since the calling LLM is already capable of doing this classification and just needs the result persisted.
  - Regardless of mode, check each filename against generic-name patterns (`IMG_\d+`, `untitled`, `Copy of `, `New Document`, `Screenshot`, purely numeric names) — if generic, call the naming logic (section 3) to attach `suggested_name`.
- Create a row in `sorter_proposals` with status `pending`, `mode_used`, and the items array (with `approved_destination`/`approved_name` initialized equal to the proposed ones).
- Return the full proposal including its `id` to the caller, so the LLM can print it to the user with the ID referenced for edits/confirm.

### `edit_sorter_proposal(proposal_id: str, filename: str, new_destination: str|None, new_name: str|None)`
- Loads the proposal, errors clearly if not found / not pending / expired.
- Finds the matching item by filename, updates `approved_destination` and/or `approved_name`.
- Returns the updated full proposal (so the LLM reprints the whole list, per the existing UX rule of never silently applying one edit).

### `confirm_sorter(proposal_id: str, confirm: bool)`
- Loads the proposal, errors clearly if not found / not pending / expired.
- If `confirm=false`: set status `cancelled`, return `{ cancelled: true }`. Move/rename nothing.
- If `confirm=true`:
  - For each item: if `approved_name` set, rename first (still within `_sorter`), then move to `approved_destination` using the same underlying logic as `apply_sort_inbox`/`move_file`.
  - Skip items with `destination: null` (no rule match, never resolved) — report them back as skipped rather than silently failing.
  - Set status `confirmed`.
  - Return a report: `{ moved: [...], renamed: [...], skipped: [...] }`.
- This tool is destructive — mark `destructiveHint: true`, not idempotent.

### `generate_name(description: str|None, filepath: str|None)`
- At least one of `description`/`filepath` required — error clearly if both missing.
- If `filepath` given: read enough of the file (reuse existing `read_file`/content-extraction logic) to infer content.
- Infer `category` (court/avo/mental/core/media/misc) from content or from the file's current folder location if already somewhere non-generic.
- Infer date from content if clearly stated; otherwise use current server date. Never fabricate a date.
- Build `YYYY-MM-DD_category-shortslug.ext`, slug = lowercase, hyphenated, 3-6 words, original extension preserved.
- Return the suggested name only — this tool never renames anything itself. Renaming happens through `edit_sorter_proposal`/`confirm_sorter` (if part of a sorter run) or a plain `move_file` (if standalone and the user explicitly approves) — reuse existing rename-via-`move_file` rather than adding a new rename tool, unless the codebase already separates rename from move.

---

## 3. Generic-filename detection (used by both `preview_sorter` and `generate_name`)

Simple regex/heuristic list, not an LLM call:
- `IMG_\d+`, `DSC_?\d+`, `VID_\d+`
- `untitled`, `Untitled`, `New Document`, `New folder`
- `Copy of `, ` (1)`, ` (2)`, ` (3)` style duplicate suffixes
- purely numeric filenames
- `Screenshot` / `Screen Shot`

If a filename matches none of these, treat it as already clear and don't offer a rename.

---

## 4. Proposal lifecycle / cleanup

- Add `expires_at` (24h from creation is reasonable) so an old pending proposal can't be confirmed days later against a `_sorter` folder that's since changed.
- On `confirm_sorter`, if `expires_at` has passed, refuse with a clear error telling the caller to run `preview_sorter` again.
- Optional: a lightweight cron/cleanup pass to mark expired proposals as `expired` — not essential for v1, skip if the codebase has no existing scheduler.

---

## 5. Backward compatibility

- Keep `preview_sort_inbox` / `apply_sort_inbox` exactly as they are — they back the legacy `/sortfiles` path and Luke's existing markdown docs already describe that as the AI-only legacy route. Don't remove or change them.
- The new tools are additive.

---

## 6. Testing checklist before calling this done

- `set_sorter_mode("rules")` → `get_sorter_mode()` reflects it.
- `preview_sorter()` with `_sorter` empty → returns `empty: true`, no proposal row created.
- `preview_sorter()` in rules mode with a mix of matching/non-matching files → correct destinations, `no rule match` for unmatched, generic filenames get `suggested_name`.
- `edit_sorter_proposal` changes only the targeted item, leaves others untouched, returns full list.
- `confirm_sorter(..., confirm=false)` moves nothing, sets status cancelled.
- `confirm_sorter(..., confirm=true)` moves/renames exactly the approved list, skips unresolved items, reports accurately.
- Re-confirming an already-confirmed or cancelled proposal_id → clear error, no double-execution.
- Confirming an expired proposal_id → clear error telling caller to re-preview.
- `generate_name` never renames a file itself; never fabricates a date; requires at least one of description/filepath.

---

## 7. What does NOT need to change

- No changes to `_system/Rules/*.md` are required by this plan — those files can stay as human/LLM-readable documentation of intended behavior. Once these tools exist, it's worth updating those docs to say "this is enforced by the server, not just convention" but that's a documentation pass, not part of this implementation.
