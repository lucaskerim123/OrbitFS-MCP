# OrbitFS Startup Load Control Contract

## Authority

The Startup UI selects the project and load request. The plain startup command opens the UI only. There is no default project, no default load request, and no file loading before the UI sends an explicit confirmed selection.

## Projects

- `1. Legal` -> `1. Legal/STARTUP.md`
- `2. Wellbeing` -> `2. Wellbeing/STARTUP.md`

## Load strengths

- `low`: project `STARTUP.md`, required configured items, and explicitly selected task files.
- `medium`: normal configured project context.
- `high`: broad configured project context.
- `custom`: exact files, folders and semantic context groups selected for that run.

## MEGA

MEGA is separate from load strength. It loads the selected project `STARTUP.md`, then every readable non-Archive file under `0. Core`, plus explicitly selected task files. It must return counts and exact loaded, skipped and failed paths.

## Required request shape

```json
{
  "project": "1. Legal",
  "loadStrength": "medium",
  "mega": false,
  "selectedItems": [],
  "taskFiles": [],
  "includeArchive": false,
  "uiSelectionConfirmed": true
}
```

## Required enforcement

- OrbitFS-relative paths only.
- Reject traversal and local filesystem paths.
- Archive excluded by default at search and read level.
- Resolve and read the live project `STARTUP.md` before other selected context.
- Record successful and failed reads separately.
- Never emit a success confirmation for failed required items.
- Keep active project and loaded context scoped per MCP client/session.
- Do not require `file_index.json`.
- Do not use a stored default project.
- Do not load any startup files from a plain startup command, model-supplied default, or partial request.
- Require explicit Startup UI confirmation before reading project, required, preset, selected, task, or MEGA files.
