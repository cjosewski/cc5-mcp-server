<#
  launch_cc5_for_test.ps1
  -----------------------
  Launch Character Creator 5 for LIVE MCP testing and wait until the bridge is up.

  Why this exists (discovered 2026-06-05):
    - CC5 5.x (5.10.x) shows a SPLASH ("Initializing...") and then may show a
      mode chooser with two big buttons: "3D Creator" and "AI Studio".
    - The MCP bridge plugin (cc5-plugin/main.py -> initialize_plugin) ONLY starts
      after CC5 fully enters **3D Creator** mode. While CC5 sits on the splash or
      the chooser, http://127.0.0.1:5101 is DOWN (connection refused).
    - A detached launch still opens a GUI window (it cannot run truly headless).
      On this machine CC5 opens on monitor 3 (a 3-monitor setup).
    - In practice CC5 usually proceeds into 3D Creator on its own within ~30-45s
      and the bridge comes up. If it stalls on the chooser, click "3D Creator"
      (the left button) — see RECOVERY below.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts/launch_cc5_for_test.ps1

  RECOVERY if the bridge never comes up (stuck on chooser):
    - The chooser is a borderless Qt window titled "Character Creator\5.0"
      (~825x466). Click the LEFT option ("3D Creator").
    - From an agent: never click or send keys to CC5 yourself. Ask the user to
      click "3D Creator", then wait for the bridge.
#>

$ErrorActionPreference = "SilentlyContinue"
$exe = "C:\Program Files\Reallusion\Character Creator 5\Bin64\CharacterCreator.exe"
$health = "http://127.0.0.1:5101/health"

# Already up?
try {
    $r = Invoke-RestMethod -Uri $health -TimeoutSec 2
    if ($r.result.status -eq "ok") { Write-Host "[launch] bridge already UP"; exit 0 }
} catch {}

if (-not (Get-Process -Name CharacterCreator -ErrorAction SilentlyContinue)) {
    Write-Host "[launch] starting CC5 (splash -> 3D Creator)..."
    Start-Process -FilePath $exe
} else {
    Write-Host "[launch] CharacterCreator.exe already running (maybe on splash/chooser)."
}

# Poll for the bridge (plugin loads only in 3D Creator mode; can take 30-60s).
$up = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-RestMethod -Uri $health -TimeoutSec 2
        if ($r.result.status -eq "ok") { $up = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
}

if ($up) {
    Write-Host "[launch] bridge UP at http://127.0.0.1:5101"
    # CC5's startup questions are the user's to answer: this script sends no keys or clicks to CC5.
    Write-Host '[launch] If CC5 shows "Unsaved project data found", answer it yourself: OK restores the auto-saved changes, Cancel discards them.'
    exit 0
} else {
    Write-Host "[launch] bridge DOWN after 120s - CC5 may be stuck on the '3D Creator / AI Studio' chooser."
    Write-Host "[launch] Click '3D Creator' (left button) on the CC5 window, then re-run this script."
    exit 1
}
