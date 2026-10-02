# CC5 MCP Bridge Plugin Installer — run in an Administrator PowerShell.
$source = Join-Path $PSScriptRoot "cc5-plugin"
$dest   = "C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge"

if (-not (Test-Path (Join-Path $source "main.py"))) {
    Write-Host "Cannot find $source\main.py. Run this script from the cc5-mcp-server folder." -ForegroundColor Red
    exit 1
}
if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
    Write-Host "Removed old plugin." -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $source "*.py") $dest
Copy-Item (Join-Path $source "config.json") $dest
Copy-Item (Join-Path $source "config.xml") $dest

$count = (Get-ChildItem $dest).Count
Write-Host "Plugin installed to: $dest ($count files)" -ForegroundColor Green
Write-Host "Restart Character Creator 5. On first start it writes its access token to $env:LOCALAPPDATA\CC5_MCP_Bridge\token" -ForegroundColor Cyan
