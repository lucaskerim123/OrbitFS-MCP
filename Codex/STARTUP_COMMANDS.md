# ChatGPT Startup Commands

These commands are for ChatGPT behavior. They do not create new MCP tools by themselves. ChatGPT should execute them by using the configured Actions, especially `readFile`, `listFolder`, `getManifest`, and later `getFolderTree`.

Hive root:

`C:\Project FireStorm\The Master Hive`

Startup files:

- Master: `_system/Startup/00_MASTER_STARTUP.md`
- Court: `_system/Startup/01_COURT_SYSTEM_STARTUP.md`
- Mental: `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`
- Media: `_system/Startup/03_MEDIA_STARTUP.md`

## Main Command

```text
/startup <domains> <load strength>
```

Examples:

```text
/startup Master normal
/startup Court light
/startup Mental full
/startup Court:Mental normal
/startup Court:Media full
```

Domains are separated with `:`.

Supported domains:

- `Master`
- `Court`
- `Mental`
- `Media`

Supported load strengths:

- `light`
- `normal`
- `full`

If the user omits load strength, use `normal`.

## Load Strengths

### light

Use when the user wants quick context.

Actions:

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read each requested domain startup file.
3. Do not scan folders.
4. Reply with the startup confirmation from the loaded domain file.

### normal

Use as the default.

Actions:

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read each requested domain startup file.
3. List only the top-level folders relevant to each requested domain.
4. Do not read evidence, notes, letters, statements, archives, or user content unless the user asks for a specific file.
5. Reply with the startup confirmation from the loaded domain file.

### full

Use only when the user asks for a deep session setup.

Actions:

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read each requested domain startup file.
3. Read `_system/Rules/load_order.md`.
4. Read `_system/Rules/project_rules.md`.
5. Read `_system/Rules/saving_rules.md`.
6. List relevant top-level and second-level folders.
7. Do not read Archive folders unless the user explicitly asks for archived material.
8. Do not read private/user content files unless needed for the requested task.
9. Reply with the startup confirmation from the loaded domain file.

## Domain Map

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

## Combined Domains

For combined startup commands, load master first, then domain files in the order given by the user.

Example:

```text
/startup Court:Mental normal
```

Actions:

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read `_system/Startup/01_COURT_SYSTEM_STARTUP.md`.
3. Read `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`.
4. List top-level folders for `1. Master Court System`, `3. Legal Charges - AVO`, and `2. Mental Health System`.
5. Confirm:

```text
Court System active. Startup loaded. Ready.
Mental Health System active. Startup loaded. Ready.
```

## Shortcut Commands

These are aliases for `/startup`.

```text
/court light
/court normal
/court full
```

Same as:

```text
/startup Court <load strength>
```

```text
/mental light
/mental normal
/mental full
```

Same as:

```text
/startup Mental <load strength>
```

```text
/media light
/media normal
/media full
```

Same as:

```text
/startup Media <load strength>
```

```text
/firestorm light
/firestorm normal
/firestorm full
```

Same as:

```text
/startup Master <load strength>
```

## Safety

- Startup commands are read-only.
- Startup commands must not write, move, delete, upload, or rename files.
- Startup commands must not read Archive folders unless explicitly requested.
- Startup commands must not read broad content folders at full depth unless the user asks for a concrete task requiring it.
- If a command is ambiguous, load `Master normal` and ask which domain the user wants.
