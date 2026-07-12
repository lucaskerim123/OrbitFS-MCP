$repoDir = $PSScriptRoot
$serverScript = Join-Path $repoDir "server.js"
$outLog = Join-Path $repoDir "out.log"
$errLog = Join-Path $repoDir "err.log"

$hivePortListening = & 'C:\Windows\System32\netstat.exe' -ano | Select-String ":3939\s.*LISTENING"
if (-not $hivePortListening) {
  Start-Process -FilePath "node" -ArgumentList $serverScript `
    -WorkingDirectory $repoDir `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog -WindowStyle Hidden
}

$tunnelRunning = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $tunnelRunning) {
  Start-Process -FilePath "C:\cloudflared\cloudflared.exe" `
    -ArgumentList '--config "C:\Users\Lucas\.cloudflared\config.yml" tunnel run master-hive' `
    -RedirectStandardOutput "C:\cloudflared\tunnel_out.log" `
    -RedirectStandardError "C:\cloudflared\tunnel_err.log" -WindowStyle Hidden
}
