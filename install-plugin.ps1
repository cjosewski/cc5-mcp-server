# CC5 MCP Bridge Plugin Installer. Run it in a PowerShell opened with "Run as administrator".
# Copies every cc5-plugin\*.py module plus config.json and config.xml into CC5's OpenPlugin folder,
# replacing an older install, and fails loudly (exit 1) if anything did not copy.
$ErrorActionPreference = "Stop"

# Checked before anything is touched: without administrator rights every copy into Program Files fails,
# and the old plugin may already have been deleted by then.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "This installer writes into Program Files and needs administrator rights. Nothing was changed." -ForegroundColor Red
    Write-Host "Open PowerShell with Run as administrator and run this again." -ForegroundColor Red
    exit 1
}

$source = Join-Path $PSScriptRoot "cc5-plugin"
$cc5Root = if ($env:CC5_ROOT) { $env:CC5_ROOT } else { "C:\Program Files\Reallusion\Character Creator 5" }
$dest = Join-Path $cc5Root "Bin64\OpenPlugin\CC5_MCP_Bridge"

if (-not (Test-Path (Join-Path $source "main.py"))) {
    Write-Host "Cannot find $source\main.py. Run this script from the cc5-mcp-server folder." -ForegroundColor Red
    exit 1
}
$files = @(Get-ChildItem (Join-Path $source "*.py") | ForEach-Object { $_.Name }) + @("config.json", "config.xml")

try {
    if (Test-Path $dest) {
        Remove-Item -Recurse -Force $dest
        Write-Host "Removed old plugin." -ForegroundColor Yellow
    }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($name in $files) {
        Copy-Item (Join-Path $source $name) $dest
    }
} catch {
    Write-Host "Install FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Fix the cause above (for example, close Character Creator 5), then run this again as administrator." -ForegroundColor Red
    exit 1
}

$missing = @($files | Where-Object { -not (Test-Path (Join-Path $dest $_)) })
if ($missing.Count -gt 0) {
    Write-Host "Install FAILED: missing from ${dest}: $($missing -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "Plugin installed to: $dest ($($files.Count) files)" -ForegroundColor Green
Write-Host "Restart Character Creator 5. On first start it writes its access token to $env:LOCALAPPDATA\CC5_MCP_Bridge\token" -ForegroundColor Cyan
