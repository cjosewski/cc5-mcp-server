# CC5 restart script: start Character Creator 5 and wait for the MCP bridge.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/cc5-restart.ps1 [-Force] [-RecoveryAnswer cancel|ok|ask]
#        powershell -ExecutionPolicy Bypass -File scripts/cc5-restart.ps1 -DialogsOnly
#
# This script never sends keys or clicks to CC5.
# -RecoveryAnswer (default cancel; Chad, 2026-10-05, flight 01 F-52): CC5 is started with CC5_RECOVERY_ANSWER set,
# and the MCP plugin answers CC5's "Unsaved project data found" prompt with that button (cancel discards the
# auto-saved changes, ok restores them) and records it. "ask" leaves the prompt for the user, as before.
# If CC5 is running, the script stops and asks the user to save and close CC5 themselves.
# -Force kills CC5 instead, and unsaved work is lost.
# -DialogsOnly only prints how to answer CC5's "Unsaved project data found" question.

param(
    [switch]$Force,
    [switch]$DialogsOnly,
    [ValidateSet("cancel", "ok", "ask")]
    [string]$RecoveryAnswer = "cancel"
)

$RecoveryGuidance = 'If CC5 shows "Unsaved project data found", answer it yourself: OK restores the auto-saved changes, Cancel discards them.'
$AutoGuidance = "The MCP plugin answers CC5's `"Unsaved project data found`" prompt with $RecoveryAnswer (CC5_RECOVERY_ANSWER); get_cc5_dialog shows when it did."

# -Force kills CC5, so the recovery prompt is the only way back to that work: leave it to the user
# unless -RecoveryAnswer was given on purpose.
if ($Force -and -not $PSBoundParameters.ContainsKey("RecoveryAnswer")) {
    $RecoveryAnswer = "ask"
}

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
Write-Host "[CC5] Launching CC5 (CC5_RECOVERY_ANSWER=$RecoveryAnswer)..."
# Start-Process passes this process's environment to CC5, where the plugin reads it.
$env:CC5_RECOVERY_ANSWER = $RecoveryAnswer
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

# 4. CC5's startup questions
if ($RecoveryAnswer -eq "ask") {
    Write-Host "[CC5] $RecoveryGuidance"
} else {
    Write-Host "[CC5] $AutoGuidance"
}
Write-Host "[CC5] === Restart Complete ==="
