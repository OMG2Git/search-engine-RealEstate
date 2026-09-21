# Registers the Next.js app as a Windows service via NSSM, so it survives
# reboots and auto-restarts on crash without a logged-in terminal window.
# Run this AFTER you've manually verified it works (npm run build &&
# npm start) — see the deployment guide for the full sequence this fits into.
#
# The crawler does NOT get its own always-on service — it runs on-demand,
# spawned by the Next.js app itself whenever someone presses "Sync New
# Files" on the /sync-files page. It always stops on its own once the pass
# over the source tree completes (never runs continuously), so there's
# nothing to keep alive in the background for it.
#
# Run as Administrator. Edit the variables below for this machine first.

$ErrorActionPreference = "Stop"

# ---- EDIT THESE FOR THIS MACHINE ----
$RepoPath = "C:\FileSearch"                  # where you copied the project
$NssmPath = "C:\FileSearch\nssm.exe"          # where you downloaded nssm.exe
$NodeExe  = (Get-Command node).Source         # auto-detected; override if needed
$LogDir   = "C:\FileSearch\logs"
# --------------------------------------

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

& $NssmPath install FileSearchApp $NodeExe "node_modules\next\dist\bin\next start"
& $NssmPath set FileSearchApp AppDirectory $RepoPath
& $NssmPath set FileSearchApp AppEnvironmentExtra "HOSTNAME=0.0.0.0" "PORT=3000"
& $NssmPath set FileSearchApp AppStdout "$LogDir\app.log"
& $NssmPath set FileSearchApp AppStderr "$LogDir\app-error.log"
& $NssmPath set FileSearchApp Start SERVICE_AUTO_START
& $NssmPath set FileSearchApp AppRestartDelay 5000

Write-Host "`nService registered. Start it with:"
Write-Host "  Start-Service FileSearchApp"
Write-Host "`nCheck status anytime with: Get-Service FileSearchApp"
Write-Host "Or open services.msc and look for 'FileSearchApp'."
Write-Host "`nTo sync new files, open the app and press 'Sync New Files' on the"
Write-Host "/sync-files page whenever needed — no separate crawler service to manage."
