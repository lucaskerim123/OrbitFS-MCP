@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*F:\hive-addon-sorter\server.js*' -or $_.CommandLine -like '*hive-addon-sorter/server.js*' -or $_.CommandLine -like '*hive-addon-sorter*server.js*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped Hive Addon Sorter PID ' + $_.ProcessId) } } else { Write-Host 'Hive Addon Sorter is not running.' }"
pause
