$hivePortListening = & 'C:\Windows\System32\netstat.exe' -ano | Select-String ":3939\s.*LISTENING"
if (-not $hivePortListening) {
  Start-Process -FilePath "node" -ArgumentList "C:\mcp-hive-server\server.js" `
    -WorkingDirectory "C:\mcp-hive-server" `
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
