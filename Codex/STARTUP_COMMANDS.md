# ChatGPT Startup Commands

These commands define ChatGPT behavior. They do not create new MCP tools by themselves.

ChatGPT should execute them through the configured read-only Actions.

Hive root:

`C:\Project FireStorm\The Master Hive`

Startup files:

- Master: `_system/Startup/00_MASTER_STARTUP.md`
- Court: `_system/Startup/01_COURT_SYSTEM_STARTUP.md`
- Mental: `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`
- Media: `_system/Startup/03_MEDIA_STARTUP.md`

Rule files loaded during startup:

- `_system/Rules/load_order.md`
- `_system/Rules/project_rules.md`
- `_system/Rules/saving_rules.md`
- `_system/Rules/commands.md`

Optional startup files:

- `_system/Index/file_index.json` if present

## Main Command

```text
/startup <project> <low|med|high>
```

Examples:

```text
/startup Master med
/startup Court low
/startup Mental high
/startup Court:Mental med
/startup Court:Media high
```

Projects are separated with `:`.

Supported projects:

- `Master`
- `Court`
- `Mental`
- `Media`

Supported load strengths:

- `low`
- `med`
- `high`

Compatibility aliases:

- `light` = `low`
- `normal` = `med`
- `full` = `high`

If the user omits load strength, use `med`.

## Startup Contract

Every startup command loads:

1. `_system/Startup/00_MASTER_STARTUP.md`
2. each requested project startup file
3. `_system/Rules/load_order.md`
4. `_system/Rules/project_rules.md`
5. `_system/Rules/saving_rules.md`
6. `_system/Rules/commands.md`
7. `_system/Index/file_index.json` if present

If multiple project startup files are requested, treat them together as the project-specific startup layer inside the shared FireStorm core.

## Load Strengths

### low

Use for fast context only.

Actions:

1. Load the full startup contract above.
2. Do not scan folders.
3. Reply with:
   - normalized command
   - files loaded
   - active rules
   - startup confirmation lines

### med

Default mode.

Actions:

1. Load the full startup contract above.
2. List only relevant top-level folders for the requested projects.
3. Never include Archive folders in startup scope.
4. Do not read user content, evidence, notes, letters, statements, or other private material unless the user asks for a specific target.
5. Reply with:
   - normalized command
   - files loaded
   - active rules
   - top-level folders now in scope
   - startup confirmation lines

### high

Use for deep startup.

Actions:

1. Load the full startup contract above.
2. List relevant top-level and second-level folders for the requested projects.
3. Never include Archive folders in startup scope unless explicitly requested.
4. Do not read broad private/user content unless required for a concrete task.
5. Reply with:
   - normalized command
   - files loaded
   - active rules
   - loaded structure summary
   - recommended next folders/files if more context is needed
   - startup confirmation lines

## Project Map

### Master

Startup file:

`_system/Startup/00_MASTER_STARTUP.md`

Relevant folders:

- `_system`
- `0. Core Folder`

Confirmation:

`Master startup loaded. Ready.`

### Court

Startup file:

`_system/Startup/01_COURT_SYSTEM_STARTUP.md`

Relevant folders:

- `1. Master Court System`
- `3. Legal Charges - AVO`

Never auto-load:

- `1. Master Court System/Archive`
- `3. Legal Charges - AVO/Archive`

Confirmation:

`Court System active. Startup loaded. Ready.`

### Mental

Startup file:

`_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`

Relevant folders:

- `2. Mental Health System`

Never auto-load:

- `2. Mental Health System/Archive`

Confirmation:

`Mental Health System active. Startup loaded. Ready.`

### Media

Startup file:

`_system/Startup/03_MEDIA_STARTUP.md`

Relevant folders:

- `Media`

Confirmation:

`Media startup loaded. Ready.`

## Combined Projects

For combined startup commands, always load Master first, then the project startup files in the exact order given by the user.

Example:

```text
/startup Court:Mental med
```

Actions:

1. Load `_system/Startup/00_MASTER_STARTUP.md`.
2. Load `_system/Startup/01_COURT_SYSTEM_STARTUP.md`.
3. Load `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`.
4. Load the full FireStorm rule set.
5. Load `_system/Index/file_index.json` if present.
6. List top-level folders for the requested projects only.
7. Confirm with the startup lines from both project startup files.

## Shortcut Commands

These are aliases for `/startup`.

```text
/court low
/court med
/court high
```

Same as:

```text
/startup Court <low|med|high>
```

```text
/mental low
/mental med
/mental high
```

Same as:

```text
/startup Mental <low|med|high>
```

```text
/media low
/media med
/media high
```

Same as:

```text
/startup Media <low|med|high>
```

```text
/firestorm low
/firestorm med
/firestorm high
```

Same as:

```text
/startup Master <low|med|high>
```

## Safety

- Startup commands are read-only.
- Startup commands must not write, move, delete, upload, rename, or create folders.
- Startup commands must not include Archive folders in startup scope unless explicitly requested.
- Startup commands must not read broad private content at depth unless the user asks for a concrete task.
- If a command is ambiguous, default to `/startup Master med` and ask which project the user wants.
