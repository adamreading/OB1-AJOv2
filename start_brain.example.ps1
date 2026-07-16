# Open Brain: Unified Startup Script (psmux edition) — EXAMPLE TEMPLATE
#
# This is the sanitized, shareable version. The maintainer's real launcher is
# `start_brain.ps1` (gitignored — it hardcodes local machine paths). Copy this
# to `start_brain.ps1` and replace the C:\Users\USER\... paths with your own.
#
# It starts the services Open Brain needs locally in a 2x2 Windows Terminal
# layout. NOTE: some referenced scripts are maintainer-private pipeline pieces
# (e.g. scripts\plaud-webhook.js) — see integrations/plaud-capture/ for a
# build-it-yourself how-to. Adapt the panes to whatever your setup runs.
#
# Pre-launch: runs recipes/brain-smoke-test (via scripts/smoke-gate.mjs) as
# a sanity check on the deployed Edge Functions + DB schema. Use -SkipSmoke
# to bypass when iterating quickly.

param(
    [switch]$SkipSmoke
)

$ProjectRoot = Get-Location
$psmux = "C:\Users\USER\AppData\Local\Microsoft\WinGet\Links\psmux.exe"
$wt    = "C:\Users\USER\AppData\Local\Microsoft\WindowsApps\wt.exe"
$ps    = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"

Write-Host ""
Write-Host "Open Brain Pro: Powering up..." -ForegroundColor Cyan

# Check for Ollama
Write-Host "Checking Ollama status..." -ForegroundColor Gray
$OllamaCheck = curl.exe -s http://localhost:11434/api/tags
if ($null -eq $OllamaCheck) {
    Write-Host "Warning: Ollama not detected at http://localhost:11434" -ForegroundColor Yellow
    Write-Host "Please start Ollama manually for background classification and entity extraction to work." -ForegroundColor Gray
} else {
    Write-Host "Ollama is online." -ForegroundColor Green
}

# --- Pre-launch smoke test gate ---
if (-not $SkipSmoke) {
    $SmokeGate = Join-Path $ProjectRoot "scripts\smoke-gate.mjs"
    if (Test-Path $SmokeGate) {
        Write-Host ""
        Write-Host "Pre-launch smoke test..." -ForegroundColor Cyan
        $smokeStart = Get-Date
        & node.exe --env-file=.env $SmokeGate
        $smokeCode = $LASTEXITCODE
        $smokeDur = [int]((Get-Date) - $smokeStart).TotalSeconds
        if ($smokeCode -eq 0) {
            Write-Host "  Smoke OK ($smokeDur s)." -ForegroundColor Green
        } elseif ($smokeCode -eq 2) {
            Write-Host "  Smoke setup-error ($smokeDur s) -- missing env var; check above. Continuing in 4s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 4
        } else {
            Write-Host "  Smoke FAIL ($smokeDur s) -- see above. Continuing in 4s; Ctrl+C to abort..." -ForegroundColor Red
            Start-Sleep -Seconds 4
        }
    } else {
        Write-Host "  (smoke-gate.mjs not found -- skipping)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Launching services in Windows Terminal (2x2)..." -ForegroundColor Cyan

$DashboardPath = Join-Path $ProjectRoot "dashboards\open-brain-dashboard-next"
# A capture webhook is a maintainer-private pipeline piece — see
# integrations/plaud-capture/ to build your own. Point this at your script.
$WebhookPath   = Join-Path $ProjectRoot "scripts\your-capture-webhook.js"
$ApplaudPath   = "C:\Users\USER\projects\YourCaptureDaemon"

# --- Reap leftover services before launching (ports + node procs by cmdline) ---
Write-Host ""
Write-Host "Reaping any leftover services..." -ForegroundColor Gray
$portsToReap = @(3010, 4001, 44471)
foreach ($p in $portsToReap) {
    $listeners = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $listeners) {
        try {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
            Write-Host "  Killing PID $($proc.Id) ($($proc.ProcessName)) on :$p" -ForegroundColor Yellow
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
        } catch {}
    }
}
Start-Sleep -Milliseconds 400

# Kill any existing psmux session, then build the 2x2 layout.
& $psmux kill-session -t "open-brain" 2>$null
& $psmux new-session -d -s "open-brain" -x 220 -y 50
$pane0 = (& $psmux list-panes -t "open-brain" -F "#{pane_id}")[0]
& $psmux split-window -h -t "open-brain:0.0"
$pane1 = (& $psmux list-panes -t "open-brain" -F "#{pane_id}" | Where-Object { $_ -ne $pane0 })[0]
& $psmux split-window -v -t $pane0
& $psmux split-window -v -t $pane1
$panes = & $psmux list-panes -t "open-brain" -F "#{pane_id}"

# Each service runs in an autorestart loop (Ctrl+C twice within 5s to stop).
& $psmux send-keys -t $panes[0] "while (`$true) { cd '$DashboardPath'; `$env:PORT=3010; `$env:HOST='0.0.0.0'; npm.cmd run dev; Write-Host 'dashboard exited - restarting in 5s (Ctrl+C to stop)' -ForegroundColor Yellow; Start-Sleep 5 }" Enter
& $psmux send-keys -t $panes[1] "while (`$true) { cd '$ProjectRoot'; node --env-file=.env '$WebhookPath'; Write-Host 'webhook exited - restarting in 5s (Ctrl+C to stop)' -ForegroundColor Yellow; Start-Sleep 5 }" Enter
& $psmux send-keys -t $panes[2] "Write-Host 'Spare pane - use for logs, a worker, or another service.' -ForegroundColor DarkGray" Enter
& $psmux send-keys -t $panes[3] "while (`$true) { cd '$ApplaudPath'; pnpm start; Write-Host 'capture daemon exited - restarting in 5s (Ctrl+C to stop)' -ForegroundColor Yellow; Start-Sleep 5 }" Enter

# Open Windows Terminal fullscreen and attach
& $wt --maximized $ps -NoExit -Command "& '$psmux' attach-session -t 'open-brain'"
