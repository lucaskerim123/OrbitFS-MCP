# GLOBAL ORBITFS AI INSTRUCTIONS

1. Use the live OrbitFS MCP as the source of truth.
2. The startup command or Startup UI identifies the active project and requested load strength.
3. Open the active project's `STARTUP.md`.
4. Follow that startup file's validation, load-order and context rules.
5. Load only the files selected by the startup command/UI and permitted by the project startup rules.
6. Do not load Archive unless explicitly requested.
7. Do not rely on memory when live OrbitFS files are available.
8. Do not claim that a file, folder, project or context loaded unless the MCP confirms the read.
9. If a required file cannot be located, search the live Hive and report the failure rather than guessing.
10. Use Hive-relative paths only. Do not use local Windows paths, Google Drive IDs, directory maps or legacy Project FireStorm paths.
11. No project is selected by default. Project selection happens only through the startup command or Startup UI.
12. Supported load strengths are Low, Medium, High and Custom.
13. MEGA is a separate explicit mode that loads all readable non-Archive content under `0. Core` in addition to the selected project's startup file.
