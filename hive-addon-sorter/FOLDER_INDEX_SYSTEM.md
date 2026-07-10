# Folder Index System

The sorter does not trust old hardcoded paths. Every `/startsorter` run rescans the current Master Hive tree and rebuilds:

`C:\Project FireStorm\The Master Hive\_system\Index\folder_index.json`

The index stores the live folder paths, folder names, generated timestamp, and searchable meaning text.

Destination rules:

- `_sorter` is scanned as the intake source.
- `_sorter` is excluded from destination suggestions.
- `_trash` is excluded from destination suggestions.
- Destination folders are resolved from the current live tree.
- The user can edit the destination before confirmation.
- The sorter does not move files during preview.
