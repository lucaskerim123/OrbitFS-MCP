Set-Location "C:\mcp-hive-server"
Start-Process -FilePath "node" -ArgumentList "C:\mcp-hive-server\server.js" `
  -RedirectStandardOutput "C:\mcp-hive-server\out.log" `
  -RedirectStandardError "C:\mcp-hive-server\err.log" -WindowStyle Hidden

Start-Sleep -Seconds 2

Start-Process -FilePath "C:\cloudflared\cloudflared.exe" `
  -ArgumentList '--config "C:\Users\Lucas\.cloudflared\config.yml" tunnel run master-hive' `
  -RedirectStandardOutput "C:\cloudflared\tunnel_out.log" `
  -RedirectStandardError "C:\cloudflared\tunnel_err.log" -WindowStyle Hidden
