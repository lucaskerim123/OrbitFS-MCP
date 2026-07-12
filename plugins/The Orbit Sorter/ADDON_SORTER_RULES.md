# Hive Sorter Rules

Root: `C:\Project FireStorm\The Master Hive`

The sorter is standalone and safe by default. It scans `_sorter`, previews suggested destinations, lets the user edit/select destinations, and only moves approved items when `/confirmsorter` is used.

User-facing commands only:

- `/startsorter`
- `/stopsorter`
- `/confirmsorter`

Rules:

- `/startsorter` rescans the live Master Hive folder tree every time.
- `/startsorter` builds or updates `_system/Index/folder_index.json`.
- Destination suggestions come from the live folder tree.
- `_sorter` and `_trash` are hidden from destination suggestions.
- Classification is by meaning first, then destination is resolved against the live folder tree.
- Files are never moved until confirmation.
Legal definitions:

- Statements means any statement made to police or court, in any format: paper, PDF, audio, video, written, victim, witness, or recorded.
- All statements go to the live folder best matching `Statements`.
- Current AVO means active AVO matters only: Jade active AVO and Laura active AVO.
- Court Days means hearings, callovers, outcomes, court dates, mentions, adjournments, and appearances.
- Current AVO is not treated as general current court material.

Whole-system controls:

- `start-sorter.bat` starts the panel/server.
- `stop-sorter.bat` stops the panel/server.
