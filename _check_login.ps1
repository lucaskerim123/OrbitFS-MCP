Write-Host "--- users.json ---"
Get-Content 'C:\Users\Lucas\Desktop\the-master-brain\users.json'

Write-Host "--- panel service status ---"
Get-Service -Name MasterBrainPanel | Select-Object Name, Status

Write-Host "--- panel process start time (has it restarted since your last PIN set?) ---"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*the-master-brain*server.js*" } | Select-Object ProcessId, CreationDate

Write-Host "--- recent service-err.log ---"
Get-Content 'C:\Users\Lucas\Desktop\the-master-brain\service-err.log' -Tail 20 -ErrorAction SilentlyContinue
