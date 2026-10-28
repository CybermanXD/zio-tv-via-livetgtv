# Registers a Windows Scheduled Task that runs the Zio TV serve endpoint at logon,
# so always-fresh playlists are available to your IPTV player automatically.
#
# Run in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
#
# Remove with:
#   Unregister-ScheduledTask -TaskName "ZioTvLivetgtv" -Confirm:$false

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js not found on PATH. Install Node 18+ first." }

$serve = Join-Path $projectRoot 'src\index.js'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$serve`" serve" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'ZioTvLivetgtv' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force -Description 'Zio TV via livetgtv playlist server'

Write-Output "Registered scheduled task 'ZioTvLivetgtv' (runs `node src\index.js serve` at logon)."
Write-Output "Start it now with: Start-ScheduledTask -TaskName ZioTvLivetgtv"
