$path = 'C:\Users\Lucas\Desktop\the-master-brain\users.json'
$users = Get-Content $path -Raw | ConvertFrom-Json
$users = @($users | Where-Object { $_.username -ne "_verifytest" })
$users | ConvertTo-Json -Depth 5 | Set-Content -Path $path -Encoding utf8 -NoNewline
Write-Host "--- users.json now ---"
Get-Content $path

Write-Host "--- confirming _paneltest folder is fully gone from the Hive ---"
Test-Path 'C:\Project FireStorm\The Master Hive\_paneltest'

Remove-Item -Force -ErrorAction SilentlyContinue 'C:\mcp-hive-server\_deploy_panel.ps1','C:\mcp-hive-server\_test_panel_api.ps1','C:\mcp-hive-server\_tmp_login.json'
Write-Host "temp files removed"
