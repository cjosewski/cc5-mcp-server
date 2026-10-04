# CC5 restart script: start Character Creator 5 and wait for the MCP bridge.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/cc5-restart.ps1 [-Force]
#        powershell -ExecutionPolicy Bypass -File scripts/cc5-restart.ps1 -DialogsOnly
#
# This script never sends keys or clicks to CC5: CC5's startup questions are for the user to answer.
# If CC5 is running, the script stops and asks the user to save and close CC5 themselves.
# -Force kills CC5 instead, and unsaved work is lost.
# -DialogsOnly only prints how to answer CC5's "Unsaved project data found" question.

param(
    [switch]$Force,
    [switch]$DialogsOnly
)

$RecoveryGuidance = 'If CC5 shows "Unsaved project data found", answer it yourself: OK restores the auto-saved changes, Cancel discards them.'

if ($DialogsOnly) {
    Write-Host "[CC5] $RecoveryGuidance"
    exit 0
}

Write-Host "[CC5] === Restart ==="

# 1. CC5 must be closed first. Killing it loses unsaved work, so only -Force does that.
$proc = Get-Process CharacterCreator -ErrorAction SilentlyContinue
if ($proc) {
    if (-not $Force) {
        Write-Host "[CC5] Character Creator 5 is running. Save your work and close CC5 yourself, then run this script again."
        Write-Host "[CC5] (-Force kills CC5 instead, and unsaved work is lost.)"
        exit 1
    }
    Write-Host "[CC5] WARNING: -Force kills CC5 now (PID: $($proc.Id -join ', ')). Unsaved work is lost."
    $proc | Stop-Process -Force
    Start-Sleep -Seconds 5
    Write-Host "[CC5] CC5 stopped."
} else {
    Write-Host "[CC5] CC5 was not running."
}

# 2. Launch CC5
$cc5Path = "C:\Program Files\Reallusion\Character Creator 5\Bin64\CharacterCreator.exe"
Write-Host "[CC5] Launching CC5..."
Start-Process $cc5Path

# 3. Wait for the bridge
Write-Host "[CC5] Waiting for the bridge..."
$up = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:5101/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($r.StatusCode -eq 200) {
            Write-Host "[CC5] Bridge up after $($i * 2)s"
            $up = $true
            break
        }
    } catch {}
}
if (-not $up) {
    Write-Host "[CC5] The bridge did not answer within 120 s. Check the CC5 window."
}

# 4. CC5's startup questions are the user's to answer
Write-Host "[CC5] $RecoveryGuidance"
Write-Host "[CC5] === Restart Complete ==="
