param(
  [string]$Root = "C:\Project FireStorm\The Master Hive",
  [int]$RetentionDays = 4,
  [switch]$EmptyNow
)

$trashPath = Join-Path $Root "_trash"
if (-not (Test-Path -LiteralPath $trashPath)) {
  Write-Output "_trash does not exist: $trashPath"
  exit 0
}

$entries = Get-ChildItem -LiteralPath $trashPath -Force
if ($EmptyNow) {
  foreach ($entry in $entries) {
    Remove-Item -LiteralPath $entry.FullName -Recurse -Force
  }
  Write-Output "Emptied _trash."
  exit 0
}

$cutoff = (Get-Date).AddDays(-1 * $RetentionDays)
$removed = 0
foreach ($entry in $entries) {
  if ($entry.LastWriteTime -gt $cutoff) { continue }
  Remove-Item -LiteralPath $entry.FullName -Recurse -Force
  $removed++
}

Write-Output "Removed $removed expired trash entr$(if ($removed -eq 1) { 'y' } else { 'ies' })."
