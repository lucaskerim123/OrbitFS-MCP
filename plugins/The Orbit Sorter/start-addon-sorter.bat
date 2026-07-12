@echo off
set "SORTER_DIR=%~dp0"
cd /d "%SORTER_DIR%"
start "OrbitFS Sorter" cmd /k "node server.js"
echo OrbitFS Sorter starting on http://localhost:4055
pause
