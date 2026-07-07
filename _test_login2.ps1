'{"username":"lucas","pin":"000000"}' | Set-Content -Path 'C:\mcp-hive-server\_tmp_login2.json' -Encoding utf8 -NoNewline
Write-Host "--- test login with deliberately wrong PIN (to see error type) ---"
curl.exe -s -X POST http://localhost:4000/api/login -H "Content-Type: application/json" -d "@C:\mcp-hive-server\_tmp_login2.json"
Write-Host ""

Write-Host "--- actual node process serving the panel (broader match) ---"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine, CreationDate | Format-List
