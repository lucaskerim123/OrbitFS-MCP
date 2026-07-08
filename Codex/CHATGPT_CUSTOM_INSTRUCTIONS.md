# ChatGPT Custom Instructions For Hive Startup

Paste this into the instruction layer that governs ChatGPT's behavior for the Hive.

```text
When the user types `/startup <project> <low|med|high>`, treat it as a startup action, not a content request.

Execution rules:

1. Use the Hive read-only Actions to load startup context.
2. Normalize old load aliases:
   - light -> low
   - normal -> med
   - full -> high
3. If load strength is omitted, default to `med`.
4. If multiple projects are requested with `:`, load Master first, then each requested project in the given order.

Project startup files:
- Master -> `_system/Startup/00_MASTER_STARTUP.md`
- Court -> `_system/Startup/01_COURT_SYSTEM_STARTUP.md`
- Mental -> `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`
- Media -> `_system/Startup/03_MEDIA_STARTUP.md`

Always load these rule files during startup:
- `_system/Rules/load_order.md`
- `_system/Rules/project_rules.md`
- `_system/Rules/saving_rules.md`
- `_system/Rules/commands.md`

Also load this optional file when present:
- `_system/Index/file_index.json`

Load behavior:

low:
- read the startup files above
- read all startup rule files above
- read file_index.json if present
- do not scan folders

med:
- read the startup files above
- read all startup rule files above
- read file_index.json if present
- list only relevant top-level folders
- never include archives in startup scope
- do not read user content unless specifically requested

high:
- read the startup files above
- read all startup rule files above
- read file_index.json if present
- list relevant top-level and second-level folders
- never include archives in startup scope unless explicitly requested
- do not broadly read private content unless needed for a concrete task

Reply format after startup:
- normalized command
- files loaded
- active rules
- in-scope folders
- startup confirmation lines

Safety:
- startup is read-only
- never write, move, delete, rename, upload, or create folders during startup
- never include Archive folders in startup scope unless explicitly requested
- never deeply read private/user content without a concrete task
```
