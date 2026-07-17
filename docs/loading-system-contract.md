# OrbitFS loading system contract

This is the target contract for making Startup, UI Load and `/loadfile` behave the same way.

## Goals

- Keep `.md`, `.json` and `.jsonl` as the best AI-readable source formats.
- Preserve original `.docx`, `.pdf` and other source files under a `_sources` folder during migration.
- Stop calling a file fully loaded unless the full extracted text was delivered and tracked.
- Make every load path use the same manifest fields so the Context UI can show what actually happened.
- Keep the UI as the main control surface.

## Canonical load pipeline

Every file load must follow the same pipeline, regardless of entry point:

```text
resolve target
→ detect file type
→ extract readable text
→ calculate source hash and size where possible
→ split into stable chunks
→ deliver chunks in order
→ record coverage
→ register active context
→ return a load report
```

Entry points covered:

- Startup UI
- Files UI load action
- `/loadfile <filepath>`
- future multi-file or folder load actions

## Active context manifest fields

Each active context record should support these fields while keeping existing fields compatible:

```json
{
  "path": "0. Core/Master Logs/Master_Incident_Log_v1.md",
  "source": "startup|manual|ui|profiles|mega",
  "status": "fully_loaded|partially_loaded|reference_only|failed",
  "characters": 120000,
  "charactersLoaded": 120000,
  "totalCharacters": 120000,
  "coveragePercent": 100,
  "truncated": false,
  "pinned": false,
  "chunksLoaded": 1,
  "totalChunks": 1,
  "hash": "sha256-if-known",
  "loadedAt": "2026-07-17T10:00:00.000Z",
  "lastAccessedAt": "2026-07-17T10:00:00.000Z",
  "warnings": []
}
```

Compatibility rule: existing UI code that reads `path`, `characters`, `source`, `truncated`, `pinned`, `loadedAt`, `lastAccessedAt` and `expiresAt` must keep working.

## Status definitions

### fully_loaded

Use only when all readable extracted text was delivered to the model and tracked.

### partially_loaded

Use when only part of the readable text was delivered because of load-strength, per-file or total character limits.

### reference_only

Use when the file was detected but readable text could not be extracted, such as binary media or scanned PDFs.

### failed

Use when the file could not be resolved, read, extracted or delivered.

## Startup load rules

Startup should load in this order:

1. System rules and startup instructions.
2. Mandatory core context: Master Logs, Mental Health Profiles Core, Luke profile, Laura profile and timeline files.
3. User-selected or task-selected files.
4. Project preset files.
5. Optional background files only if the selected load strength allows it.

Startup should return a report containing:

- loaded files
- failed files
- partially loaded files
- total characters loaded
- total readable characters encountered
- active context count
- warning list

## Manual `/loadfile` rules

`/loadfile` should try to fully load the complete readable file.

It should support:

- `.md`
- `.txt`
- `.json`
- `.jsonl`
- `.csv`
- `.docx`
- text-based `.pdf`

If a file is too large for a single response, the server should record it as partially loaded and expose continuation metadata rather than pretending it is complete.

## UI rules

- View/preview should open a rendered viewer and should not automatically mark the file as active context.
- Load should mark the file as active context only through the canonical load pipeline.
- Context UI should show full/partial/reference/failed state.
- Context UI should show loaded characters, total characters, chunks and warnings.
- Unload should remove the active-context record but cannot erase text already sent earlier in the chat.

## Conversion and export rules

Authoritative AI-readable files should be `.md`, `.json` or `.jsonl`.

Original files should be preserved:

```text
Folder/
  File.md
  _sources/
    File.docx
```

Exports should be generated from the current source on demand:

- DOCX
- PDF
- TXT
- HTML
- original Markdown

Do not store exported copies permanently unless the user explicitly saves them.

## Implementation order

1. Extend active context records with coverage/status fields.
2. Make `trackFile` accept a metadata object while still supporting old calls.
3. Mark manual loads as `fully_loaded` when not truncated.
4. Mark Startup optional files as `partially_loaded` when character limits cut the content.
5. Add Context UI display for status and coverage.
6. Add Markdown rendered viewer/editor.
7. Add on-demand export endpoints.
