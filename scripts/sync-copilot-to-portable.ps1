<#
.SYNOPSIS
    Build the in-tree copilot extension and sync it into the portable TheCoder bundle.

.DESCRIPTION
    The full `build-release.ps1` pipeline ships whatever was baked into the last
    gulp build. TheCoder customizations live in `extensions/copilot/` and must be
    compiled + copied separately until the next full rebuild.

    This script:
      1. Runs `npm run build` in extensions/copilot
      2. Copies package.json + dist/ into releases/portable/portable/resources/app/extensions/copilot/

.EXAMPLE
    pwsh -File scripts/sync-copilot-to-portable.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$copilotSrc = Join-Path $repoRoot 'extensions\copilot'
$portableExt = Join-Path $repoRoot 'releases\portable\portable\resources\app\extensions\copilot'

if (-not (Test-Path $portableExt)) {
    throw "Portable copilot extension not found at: $portableExt`nRun build-release.ps1 first or adjust the path."
}

Write-Host "Building copilot extension..." -ForegroundColor Cyan
Push-Location $copilotSrc
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "copilot build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$distSrc = Join-Path $copilotSrc 'dist'
if (-not (Test-Path $distSrc)) {
    throw "Expected dist/ after build at $distSrc"
}

Write-Host "Syncing to portable: $portableExt" -ForegroundColor Cyan
Copy-Item (Join-Path $copilotSrc 'package.json') (Join-Path $portableExt 'package.json') -Force

$distDst = Join-Path $portableExt 'dist'
if (Test-Path $distDst) { Remove-Item $distDst -Recurse -Force }
Copy-Item $distSrc $distDst -Recurse -Force

$hasCmd = Select-String -Path (Join-Path $portableExt 'dist\extension.js') -Pattern 'configureDeepSeekApiKey' -Quiet
$noBalance = -not (Select-String -Path (Join-Path $portableExt 'dist\extension.js') -Pattern 'DeepSeekBalanceProvider' -Quiet)

Write-Host "  extension.js has configureDeepSeekApiKey : $hasCmd" -ForegroundColor $(if ($hasCmd) { 'Green' } else { 'Red' })
Write-Host "  extension.js has no DeepSeekBalanceProvider : $noBalance" -ForegroundColor $(if ($noBalance) { 'Green' } else { 'Red' })

Write-Host ""
Write-Host "Done. Restart thecoder.exe from releases/portable/portable/" -ForegroundColor Green
