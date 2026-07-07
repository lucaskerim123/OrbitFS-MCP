Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process -FilePath "C:\cloudflared\cloudflared.exe" `
  -ArgumentList '--config "C:\Users\Lucas\.cloudflared\config.yml" tunnel run master-hive' `
  -RedirectStandardOutput "C:\cloudflared\tunnel_out.log" `
  -RedirectStandardError "C:\cloudflared\tunnel_err.log" -WindowStyle Hidden
Start-Sleep -Seconds 5
Write-Host "--- final process count ---"
Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object Id, StartTime
Write-Host "--- hive reachable? ---"
try {
  $r = Invoke-WebRequest -Uri "https://hive.incendiarynetworks.cc/.well-known/oauth-authorization-server" -UseBasicParsing -TimeoutSec 15
  Write-Host "OK $($r.StatusCode)"
} catch { Write-Host "FAILED: $($_.Exception.Message)" }

# revert the local ingress edit for brain - it's ignored anyway since this tunnel is remotely-managed,
# leaving it in would be misleading documentation
$path = 'C:\Users\Lucas\.cloudflared\config.yml'
$content = @"
tunnel: 77da9376-aa43-4d46-a12c-5b4e40b461ec
credentials-file: C:\Users\Lucas\.cloudflared\77da9376-aa43-4d46-a12c-5b4e40b461ec.json

ingress:
  - hostname: hive.incendiarynetworks.cc
    service: http://localhost:3939
  - service: http_status:404
"@
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "--- config.yml reverted (remote-managed tunnel ignores local ingress anyway) ---"

Remove-Item -Force -ErrorAction SilentlyContinue 'C:\mcp-hive-server\_restart_tunnel.ps1','C:\mcp-hive-server\_recheck_config.ps1','C:\mcp-hive-server\_recheck2.ps1','C:\mcp-hive-server\_check_tunnel_now.ps1'
