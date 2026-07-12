@echo off
set "SORTER_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = [IO.Path]::GetFullPath('%SORTER_DIR%'); $needle = [IO.Path]::Combine($dir, 'server.js'); $p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $needle + '*') -or $_.CommandLine -like '*orbitfs-sorter*server.js*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped OrbitFS Sorter PID ' + $_.ProcessId) } } else { Write-Host 'OrbitFS Sorter is not running.' }"
pause
