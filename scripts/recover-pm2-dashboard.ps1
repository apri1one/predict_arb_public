$ErrorActionPreference = "Stop"

Set-Location -Path "E:\predict-engine"

try { pm2 delete all | Out-Null } catch {}
try { pm2 kill | Out-Null } catch {}

pm2 start .\ecosystem.windows.json

Write-Host "Waiting for dashboard to boot..."
Start-Sleep -Seconds 10

pm2 status
pm2 logs dashboard --lines 60
