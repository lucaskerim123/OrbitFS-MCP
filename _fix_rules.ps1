$key = (Get-Content "C:\mcp-hive-server\.env" | Select-String "^HIVE_API_KEY").ToString().Split("=")[1]
$headers = @{ Authorization = "Bearer $key"; "Content-Type" = "application/json"; "Accept" = "application/json, text/event-stream" }

function Write-Hive($filepath, $content) {
  $payload = @{ jsonrpc = "2.0"; id = 1; method = "tools/call"; params = @{ name = "write_file"; arguments = @{ filepath = $filepath; content = $content } } } | ConvertTo-Json -Depth 10
  $r = Invoke-WebRequest -Uri "https://hive.incendiarynetworks.cc/mcp" -Method Post -Headers $headers -Body $payload -UseBasicParsing
  Write-Output "$filepath -> $($r.StatusCode)"
}

$savingRules = @"
# Saving Rules

## If unsure

Save to the relevant waiting folder:

- Court unsure:
  1. Master Court System/0. Waiting To Be Sorted - Approval Required

- Mental-health unsure:
  2. Mental Health System/0. Waiting To Be Sorted - Approval Required

## Shared core material

- Master incident logs:
  0. Core Folder/Master Logs

- Relationship timeline:
  0. Core Folder/Master Logs

- Shared notes:
  0. Core Folder/Shared Notes

- Profiles:
  0. Core Folder/Profiles
"@

$savingRules += @"


## Court material

- Court drafts and outputs:
  1. Master Court System/Court Documents

- Evidence bundles:
  1. Master Court System/Evidence Files

- Statements:
  1. Master Court System/Statements

- Court-day specific material:
  1. Master Court System/Court Days

## Mental-health material

- Vent entries:
  2. Mental Health System/Pure Vent Mode

- Letters:
  2. Mental Health System/Letters - Documents

- Sessions:
  2. Mental Health System/Sessions

- Notes:
  2. Mental Health System/Notes

## Legal Charges / AVO material

- AVO documents:
  3. Legal Charges - AVO/Current AVO

- Incidents:
  3. Legal Charges - AVO/Incidents

- Legal statements:
  3. Legal Charges - AVO/Statements

- CCO material:
  3. Legal Charges - AVO/Convicted - CCO

- ICO material:
  3. Legal Charges - AVO/Convicted - ICO

- Active matters:
  3. Legal Charges - AVO/Active Matters

## Sorting workflow (_sorter)

- Anything uploaded via ChatGPT or Claude lands in _sorter first.
- From _sorter, triage into the right system's waiting folder:
  - Court/legal/AVO-leaning: 1. Master Court System/0. Waiting To Be Sorted - Approval Required
  - Mental-health-leaning: 2. Mental Health System/0. Waiting To Be Sorted - Approval Required
- From a waiting folder, propose a specific destination (per the rules above) and move only after approval.
- Never move a file without presenting the proposed destination first.

## Media

- Photos:
  Media/Photos

- Videos:
  Media/Videos

- Audio:
  Media/Audio
"@

Write-Hive "_system/Rules/saving_rules.md" $savingRules

$chatgptInstructions = @"
# ChatGPT / MCP Instructions

For Project FireStorm, use this root folder:

C:\Project FireStorm\The Master Hive

Before answering anything related to Project FireStorm:

1. Read _system/Startup/00_MASTER_STARTUP.md.
2. Read _system/Rules/load_order.md.
3. Read _system/Rules/project_rules.md.
4. Read _system/Rules/saving_rules.md.
5. Read _system/Index/file_index.json if available.
6. Detect the correct subsystem:
   - Court/legal/AVO/charges/evidence/statements/bail/ICO/CCO = Court + Legal Charges
   - Mental health/vent/profile/session/personal = Mental Health
   - Photos/videos/audio = Media
7. Load the relevant startup file:
   - _system/Startup/01_COURT_SYSTEM_STARTUP.md
   - _system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md
   - _system/Startup/03_MEDIA_STARTUP.md

Rules:
- Use 0. Core Folder as shared truth.
- Use project folders as working systems.
- Use 3. Legal Charges - AVO as shared legal source material.
- Do not load archive folders unless explicitly asked.
- Never overwrite without reading first.
- Never delete unless explicitly asked.
- New uploads go to _sorter first, then get triaged into a waiting folder, then sorted into their final home after approval.
"@

Write-Hive "_system/chatgpt_mcp_instructions.md" $chatgptInstructions

$projectRules = @"
# Project Rules

The Master Hive is organised like a private Google Drive.

## Top-level folders

_system
- Startup files, load rules, project rules, saving rules, index, and scripts.

0. Core Folder
- Shared truth used by all systems.
- Master logs, relationship timeline, shared notes, and reusable profiles.

1. Master Court System
- Court workflow, court documents, court days, evidence bundles, imports, and outputs.

2. Mental Health System
- Mental health workflow, vent entries, letters, sessions, personal notes, imports, and outputs.

3. Legal Charges - AVO
- Legal source material for charges, AVO, statements, incidents, bail, ICO, CCO, and active matters.

Media
- Original photos, videos, and audio.

_sorter
- Inbox for anything uploaded via ChatGPT or Claude, before it's triaged into a waiting folder and sorted after approval.

## Core Rules

- Read before editing.
- Never overwrite a file without reading it first.
- Never delete files unless explicitly asked.
- Use waiting/sorting folders when unsure.
- Do not load Archive folders unless explicitly requested.
- Prefer 0. Core Folder for shared facts that multiple projects need.
- Never move a file out of _sorter or a waiting folder without presenting the proposed destination first and getting approval.
"@

Write-Hive "_system/Rules/project_rules.md" $projectRules

$loadOrder = @"
# Load Order

Universal Project FireStorm load order:

1. _system/Startup/00_MASTER_STARTUP.md
2. _system/Rules/load_order.md
3. _system/Rules/project_rules.md
4. _system/Rules/saving_rules.md
5. _system/Index/file_index.json

Then detect task type.

## Court / Legal / AVO / Evidence

Load:
1. _system/Startup/01_COURT_SYSTEM_STARTUP.md
2. 0. Core Folder
3. 3. Legal Charges - AVO
4. 1. Master Court System

## Mental Health / Vent / Personal / Profiles

Load:
1. _system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md
2. 0. Core Folder
3. 2. Mental Health System

Only load 3. Legal Charges - AVO if legal context is relevant.

## Media

Load:
1. _system/Startup/03_MEDIA_STARTUP.md
2. Media

## Sorting

New uploads land in _sorter. Triage into the relevant waiting folder, then sort into a final home only after approval.

## Archive Rule

Do not load or search Archive folders unless the user explicitly asks to include archived material.
"@

Write-Hive "_system/Rules/load_order.md" $loadOrder

$masterStartup = @"
# 00_MASTER_STARTUP

Root:
C:\Project FireStorm\The Master Hive

The Master Hive is the core private drive for Project FireStorm.

Before answering anything related to Project FireStorm:

1. Read this file.
2. Read _system/Rules/load_order.md.
3. Read _system/Rules/project_rules.md.
4. Read _system/Rules/saving_rules.md.
5. Read _system/Index/file_index.json if it exists.
6. Detect the correct subsystem:
   - Court/legal/AVO/charges/evidence/statements/bail/ICO/CCO = 1. Master Court System and 3. Legal Charges - AVO
   - Mental health/vent/profiles/sessions/personal notes = 2. Mental Health System
   - Photos/videos/audio = Media
7. Load 0. Core Folder for shared truth when relevant.

Core principle:
- 0. Core Folder is shared truth.
- Project folders are working systems.
- 3. Legal Charges - AVO is shared legal source material.
- Archive folders are not loaded unless explicitly requested.
- New uploads go to _sorter, get triaged into a waiting folder, then sorted into a final home only after approval.
"@

Write-Hive "_system/Startup/00_MASTER_STARTUP.md" $masterStartup

$courtStartup = @"
# 01_COURT_SYSTEM_STARTUP

Use this startup file for court, legal, AVO, charges, evidence, statements, bail, ICO, CCO, timelines, court-day, and case-document tasks.

Load order for court tasks:

1. _system/Startup/00_MASTER_STARTUP.md
2. _system/Rules/load_order.md
3. _system/Rules/project_rules.md
4. _system/Index/file_index.json
5. 0. Core Folder
6. 3. Legal Charges - AVO
7. 1. Master Court System

Search locations:
- 0. Core Folder/Master Logs
- 0. Core Folder/Profiles
- 3. Legal Charges - AVO
- 1. Master Court System/Evidence Files
- 1. Master Court System/Statements
- 1. Master Court System/Court Documents
- 1. Master Court System/Court Days

Saving:
- Unsure court item: 1. Master Court System/0. Waiting To Be Sorted - Approval Required
- Court drafts/outputs: 1. Master Court System/Court Documents
- Court evidence bundles: 1. Master Court System/Evidence Files
- Legal source material: 3. Legal Charges - AVO
- Shared profiles: 0. Core Folder/Profiles
- Shared logs/timelines: 0. Core Folder/Master Logs
"@

Write-Hive "_system/Startup/01_COURT_SYSTEM_STARTUP.md" $courtStartup

$mentalHealthStartup = @"
# 02_MENTAL_HEALTH_SYSTEM_STARTUP

Use this startup file for mental health, venting, profiles, personal notes, sessions, letters, and emotional-log tasks.

Load order for mental-health tasks:

1. _system/Startup/00_MASTER_STARTUP.md
2. _system/Rules/load_order.md
3. _system/Rules/project_rules.md
4. _system/Index/file_index.json
5. 0. Core Folder
6. 2. Mental Health System

Only load 3. Legal Charges - AVO when the topic touches:
- court
- charges
- AVO
- allegations
- statements
- evidence
- bail
- ICO/CCO

Saving:
- Unsure mental-health item: 2. Mental Health System/0. Waiting To Be Sorted - Approval Required
- New vent entries: 2. Mental Health System/Pure Vent Mode
- Letters: 2. Mental Health System/Letters - Documents
- Sessions: 2. Mental Health System/Sessions
- Notes: 2. Mental Health System/Notes
- Shared profiles: 0. Core Folder/Profiles
"@

Write-Hive "_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md" $mentalHealthStartup

$mediaStartup = @"
# 03_MEDIA_STARTUP

Use this startup file for photos, videos, audio, screenshots, recordings, and media evidence.

Media folders:
- Photos: Media/Photos
- Videos: Media/Videos
- Audio: Media/Audio

Rules:
- Do not rename or delete original media unless explicitly asked.
- If media is legal evidence, record its relevance in 1. Master Court System/Evidence Files or 3. Legal Charges - AVO.
- If media is personal/mental-health context, record its relevance in 2. Mental Health System/Notes.
- Keep original media files in Media.
"@

Write-Hive "_system/Startup/03_MEDIA_STARTUP.md" $mediaStartup
