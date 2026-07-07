$nodeRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*mcp-hive-server*server.js*" }
if (-not $nodeRunning) {
  Start-Process -FilePath "node" -ArgumentList "C:\mcp-hive-server\server.js" `
    -RedirectStandardOutput "C:\mcp-hive-server\out.log" `
    -RedirectStandardError "C:\mcp-hive-server\err.log" -WindowStyle Hidden
}

$tunnelRunning = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $tunnelRunning) {
  Start-Process -FilePath "C:\cloudflared\cloudflared.exe" `
    -ArgumentList '--config "C:\Users\Lucas\.cloudflared\config.yml" tunnel run master-hive' `
    -RedirectStandardOutput "C:\cloudflared\tunnel_out.log" `
    -RedirectStandardError "C:\cloudflared\tunnel_err.log" -WindowStyle Hidden
}
