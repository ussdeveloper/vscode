<#
.SYNOPSIS
    Build TheCoder Windows installer + portable distribution.

.DESCRIPTION
    Wraps the upstream VS Code Windows packaging tasks (`vscode-win32-<arch>-min`,
    `vscode-win32-<arch>-inno-updater`, `vscode-win32-<arch>-{system,user}-setup`)
    and stages the artifacts under:

      releases/install/<version>/                     - versioned installers
      releases/portable/portable/                     - ALWAYS the latest portable
      releases/portable/<name>__<timestamp>.zip       - previous portables, archived

    The latest portable build always lives unzipped at
    `releases/portable/portable/` (no version suffix in the path) so you can
    just double-click `thecoder.exe` there. Whenever a new portable is built,
    the previous `portable/` directory is zipped with a human-readable
    timestamp suffix (`TheCoder-portable-<arch>-<oldver>__YYYY-MM-DD_HH-mm-ss.zip`)
    and dropped next to it before the fresh build is staged.

    Portable mode is enabled by dropping an empty `data\` folder next to
    `TheCoder.exe` inside the unpacked build; on first launch VS Code detects
    it and routes ALL user data (settings, extensions, workspace storage)
    into that folder instead of %APPDATA%, making the directory fully movable.

.PARAMETER Arch
    Target architecture. Default: x64. Other accepted: arm64.

.PARAMETER SkipBuild
    Skip the heavyweight `vscode-win32-<arch>-min-ci` step. Useful when you
    just ran a build and only want to re-package.

.PARAMETER SkipInstaller
    Don't produce the Inno Setup installers.

.PARAMETER SkipPortable
    Don't produce the portable zip.

.PARAMETER PortableOnly
    Equivalent to -SkipInstaller. Convenience flag for the common case where
    you only want a fast portable bundle for a USB stick.

.EXAMPLE
    pwsh -File scripts/build-release.ps1
    # Full pipeline: min build -> installers -> portable zip.

.EXAMPLE
    pwsh -File scripts/build-release.ps1 -SkipBuild -PortableOnly
    # Repackage a portable from the last build directory only.
#>
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64',
    [switch]$SkipBuild,
    [switch]$SkipInstaller,
    [switch]$SkipPortable,
    [switch]$PortableOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PortableOnly) { $SkipInstaller = $true }

# ---------------------------------------------------------------------------
# Pre-flight: kill running TheCoder instances
#
# The dev-mode TheCoder process keeps several native modules from the copilot
# extension (e.g. `@github/copilot/sdk/prebuilds/win32-x64/runtime.node`)
# memory-mapped, which makes Windows refuse to overwrite/unlink them during
# the build's postinstall + clean-extensions-build steps. The resulting EPERM
# fails the entire pipeline ~30 seconds in. We sweep them here so the user
# doesn't have to remember.
# ---------------------------------------------------------------------------

function Stop-TheCoderProcesses {
    # Match ANY thecoder.exe regardless of install location:
    #  - dev build under .build\electron\thecoder.exe (watcher / dev launches)
    #  - portable build under releases\portable\<version>\... (a previous run
    #    may have left an instance running which holds open
    #    `data\user-data\state.vscdb` and blocks Remove-Item when re-staging)
    #  - any other location (installer-installed, user-launched copy)
    $procs = Get-Process -Name 'thecoder' -ErrorAction SilentlyContinue
    if (-not $procs) { return }
    Write-Host "Pre-flight: killing $($procs.Count) running thecoder.exe process(es) to release file locks..." -ForegroundColor Yellow
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 4
    # Second sweep -- children sometimes outlive their parents on Windows.
    Get-Process -Name 'thecoder' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Always run the sweep -- locked files from a portable instance also break
# the -SkipBuild path because we still wipe + restage the portable directory.
Stop-TheCoderProcesses

# ---------------------------------------------------------------------------
# Pre-flight: ensure signtool.exe is on PATH
#
# `patchWin32DependenciesTask` (in build/gulpfile.vscode.ts) shells out to
# `signtool.exe verify /pa <file>` for every *.node, rg.exe, and explorer
# command DLL it finds in the packaged build to decide whether an existing
# Authenticode signature needs stripping before rcedit rewrites the version
# resource. When signtool isn't on PATH the spawn fails with ENOENT and
# crashes the entire build at the very last packaging step. The official
# Azure pipeline solves this by prepending the Windows 10 SDK x64 bin folder;
# we do the same, autodetecting the newest SDK version actually installed.
# ---------------------------------------------------------------------------

function Ensure-SigntoolOnPath {
    if (Get-Command signtool.exe -ErrorAction SilentlyContinue) {
        Write-Host "Pre-flight: signtool.exe already on PATH." -ForegroundColor DarkGray
        return
    }
    $kitsBin = 'C:\Program Files (x86)\Windows Kits\10\bin'
    if (-not (Test-Path $kitsBin)) {
        Write-Host "Pre-flight: WARNING - signtool.exe not found and Windows 10 SDK bin folder ($kitsBin) is missing. Build will likely fail at patchWin32DependenciesTask." -ForegroundColor Red
        return
    }
    # Pick newest 10.0.x.0 version that ships an x64 signtool.exe.
    $candidate = Get-ChildItem $kitsBin -Directory `
        | Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } `
        | Sort-Object { [version]$_.Name } -Descending `
        | Where-Object { Test-Path (Join-Path $_.FullName 'x64\signtool.exe') } `
        | Select-Object -First 1
    if (-not $candidate) {
        Write-Host "Pre-flight: WARNING - no x64 signtool.exe under $kitsBin\10.0.*\x64\. Build will likely fail." -ForegroundColor Red
        return
    }
    $sdkBin = Join-Path $candidate.FullName 'x64'
    $env:PATH = "$sdkBin;$env:PATH"
    Write-Host "Pre-flight: prepended Windows SDK $($candidate.Name) x64 bin to PATH ($sdkBin)." -ForegroundColor DarkGray
}

Ensure-SigntoolOnPath

# ---------------------------------------------------------------------------
# Paths & version
# ---------------------------------------------------------------------------

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $repoRoot

$pkg = Get-Content "$repoRoot\package.json" -Raw | ConvertFrom-Json
$product = Get-Content "$repoRoot\product.json" -Raw | ConvertFrom-Json

$version = $pkg.version
$appName = $product.nameShort                # 'thecoder'
$appDir = $product.win32DirName              # 'TheCoder'

# Pull short commit if we're in a git repo; non-fatal otherwise.
$shortCommit = $null
try {
    $shortCommit = (& git rev-parse --short HEAD 2>$null).Trim()
} catch { }
$versionLabel = if ($shortCommit) { "$version+$shortCommit" } else { $version }

$buildOutDir = Join-Path (Split-Path $repoRoot -Parent) "VSCode-win32-$Arch"
$setupSystemDir = Join-Path $repoRoot ".build\win32-$Arch\system-setup"
$setupUserDir = Join-Path $repoRoot ".build\win32-$Arch\user-setup"

$releasesRoot = Join-Path $repoRoot 'releases'
$installOutDir = Join-Path $releasesRoot "install\$versionLabel"

# Portable layout (per user request):
#   releases/portable/portable/                            <- ALWAYS latest, no version
#   releases/portable/<name>__<timestamp>.zip              <- archived prior builds
# The "latest" portable directory has a stable, versionless name so end users
# can just double-click `thecoder.exe` there without hunting for the newest
# version subfolder. Older portables get rolled up into a single timestamped
# zip dropped at the same level (NOT inside a per-version subdirectory).
$portableRoot     = Join-Path $releasesRoot 'portable'
$portableLatestDir = Join-Path $portableRoot 'portable'

# Cosmetic helper.
function Section($title) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host (" $title") -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkGray
}

Section "TheCoder release builder"
Write-Host "Repo root      : $repoRoot"
Write-Host "Arch           : $Arch"
Write-Host "Version label  : $versionLabel"
Write-Host "Build output   : $buildOutDir"
Write-Host "Install target : $installOutDir"
Write-Host "Portable target: $portableLatestDir  (always-latest)"
Write-Host "Portable archive: $portableRoot\<name>__<timestamp>.zip  (previous builds)"
if ($SkipBuild)     { Write-Host '  [skip] min-ci build' -ForegroundColor Yellow }
if ($SkipInstaller) { Write-Host '  [skip] installers'    -ForegroundColor Yellow }
if ($SkipPortable)  { Write-Host '  [skip] portable zip'  -ForegroundColor Yellow }

# The min-ci gulp task uses TypeScript via tsx, which respects this flag.
$env:VSCODE_SKIP_NODE_VERSION_CHECK = '1'

# ---------------------------------------------------------------------------
# 1. Main build (`vscode-win32-<arch>-min-ci`) -- produces ..\VSCode-win32-<arch>\
# ---------------------------------------------------------------------------

if (-not $SkipBuild) {
    # `vscode-win32-<arch>-min` is the full pipeline: compile + bundle/minify
    # + package. The "-ci" sibling only runs the package step and expects
    # `out-vscode-min/` to be pre-populated (split for parallel CI jobs).
    Section "Step 1/4  gulp vscode-win32-$Arch-min"
    Write-Host "This is the heavy one -- typically 20-50 minutes on a workstation." -ForegroundColor DarkGray
    & npm.cmd run gulp -- "vscode-win32-$Arch-min"
    if ($LASTEXITCODE -ne 0) { throw "min build failed (exit $LASTEXITCODE)" }
}

if (-not $SkipInstaller -or -not $SkipPortable) {
    if (-not (Test-Path (Join-Path $buildOutDir "$appName.exe"))) {
        throw "Expected $appName.exe inside '$buildOutDir' but it's not there. Did the build succeed?"
    }
}

# ---------------------------------------------------------------------------
# 2. Inno updater (small, always runs unless explicitly skipped via -SkipBuild)
# ---------------------------------------------------------------------------

if (-not $SkipBuild) {
    Section "Step 2/4  gulp vscode-win32-$Arch-inno-updater"
    & npm.cmd run gulp -- "vscode-win32-$Arch-inno-updater"
    if ($LASTEXITCODE -ne 0) { throw "inno-updater task failed (exit $LASTEXITCODE)" }
}

# ---------------------------------------------------------------------------
# 3. Installers (system + user) → releases/install/<version>/
# ---------------------------------------------------------------------------

if (-not $SkipInstaller) {
    Section "Step 3/4  Inno Setup installers"
    & npm.cmd run gulp -- "vscode-win32-$Arch-system-setup"
    if ($LASTEXITCODE -ne 0) { throw "system-setup build failed (exit $LASTEXITCODE)" }
    & npm.cmd run gulp -- "vscode-win32-$Arch-user-setup"
    if ($LASTEXITCODE -ne 0) { throw "user-setup build failed (exit $LASTEXITCODE)" }

    if (Test-Path $installOutDir) { Remove-Item $installOutDir -Recurse -Force }
    New-Item -ItemType Directory -Path $installOutDir | Out-Null

    # Inno Setup emits a single .exe per OutputDir; rename for clarity.
    $systemSrc = Get-ChildItem $setupSystemDir -Filter '*.exe' | Select-Object -First 1
    $userSrc = Get-ChildItem $setupUserDir -Filter '*.exe' | Select-Object -First 1
    if (-not $systemSrc) { throw "No installer .exe in $setupSystemDir" }
    if (-not $userSrc)   { throw "No installer .exe in $setupUserDir"   }

    $systemDst = Join-Path $installOutDir "$appDir`Setup-$Arch-$versionLabel.exe"
    $userDst   = Join-Path $installOutDir "$appDir`UserSetup-$Arch-$versionLabel.exe"
    Copy-Item $systemSrc.FullName $systemDst -Force
    Copy-Item $userSrc.FullName   $userDst   -Force

    Write-Host ('  -> ' + (Split-Path $systemDst -Leaf) + '  (' + [math]::Round($systemSrc.Length/1MB,1) + ' MB)')
    Write-Host ('  -> ' + (Split-Path $userDst   -Leaf) + '  (' + [math]::Round($userSrc.Length/1MB,1)   + ' MB)')

    # checksums
    $sums = @()
    foreach ($f in @($systemDst, $userDst)) {
        $h = (Get-FileHash -Algorithm SHA256 $f).Hash
        $sums += "$h  $(Split-Path $f -Leaf)"
    }
    Set-Content -Path (Join-Path $installOutDir 'checksums.txt') -Value $sums -Encoding ASCII
}

# ---------------------------------------------------------------------------
# 4. Portable directory -> releases/portable/portable/
#
# Layout (per user request):
#   releases/portable/portable/                          <- always-latest, no ver
#   releases/portable/<name>__<timestamp>.zip            <- archived prior builds
#   releases/portable/checksums.txt                      <- sha256 of all zips
#
# Flow on each run:
#   1. If `portable/` already exists, read its version (from
#      `resources/app/package.json`) and zip the whole directory as
#      `TheCoder-portable-<arch>-<oldver>__<ts>.zip` next to it. Then delete
#      the old directory so the new build can replace it cleanly.
#   2. Robocopy the fresh build into `portable/`, drop the `data\` marker
#      for VS Code's portable mode, and write PORTABLE_README.txt.
#   3. Refresh checksums.txt over every archived .zip in the parent folder.
# Note: the LATEST portable is deliberately left UNZIPPED -- only replaced
# builds get zipped, mirroring the user's spec exactly.
# ---------------------------------------------------------------------------

if (-not $SkipPortable) {
    Section "Step 4/4  Portable bundle"

    if (-not (Test-Path $portableRoot)) {
        New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null
    }

    # -- Step 4a. Archive the previous `portable/` if it exists --------------
    if (Test-Path $portableLatestDir) {
        # Recover the version of the existing portable so the archive zip
        # carries a meaningful name. Fall back to "unknown" if package.json
        # is missing or malformed; never let this block the build.
        $oldVer = 'unknown'
        $oldPkgPath = Join-Path $portableLatestDir 'resources\app\package.json'
        if (Test-Path $oldPkgPath) {
            try {
                $oldPkg = Get-Content $oldPkgPath -Raw | ConvertFrom-Json
                if ($oldPkg.version) {
                    $oldVer = $oldPkg.version
                    # Try to pull the commit too, mirroring versionLabel format.
                    $oldCommitPath = Join-Path $portableLatestDir 'resources\app\product.json'
                    if (Test-Path $oldCommitPath) {
                        $oldProduct = Get-Content $oldCommitPath -Raw | ConvertFrom-Json
                        if ($oldProduct.commit) {
                            $shortOld = $oldProduct.commit.Substring(0, [Math]::Min(11, $oldProduct.commit.Length))
                            $oldVer = "$oldVer+$shortOld"
                        }
                    }
                }
            } catch { Write-Host "  WARN: couldn't read old portable version ($_); using 'unknown'." -ForegroundColor Yellow }
        }

        $ts = (Get-Date).ToString('yyyy-MM-dd_HH-mm-ss')
        $archiveName = "$appDir-portable-$Arch-$oldVer" + "__$ts.zip"
        $archivePath = Join-Path $portableRoot $archiveName

        # Collision guard: if a zip with the same timestamp already exists
        # (back-to-back runs in the same second), suffix .2/.3/...
        if (Test-Path $archivePath) {
            $n = 2
            while (Test-Path (Join-Path $portableRoot ("$appDir-portable-$Arch-$oldVer" + "__$ts.$n.zip"))) { $n++ }
            $archivePath = Join-Path $portableRoot ("$appDir-portable-$Arch-$oldVer" + "__$ts.$n.zip")
        }

        Write-Host "  Archiving previous portable build (v$oldVer):" -ForegroundColor DarkGray
        Write-Host "    -> $(Split-Path $archivePath -Leaf)" -ForegroundColor DarkGray
        # Compress-Archive on a folder includes the folder itself in the zip;
        # we want the contents at the root, so we glob into it instead.
        try {
            Compress-Archive -Path (Join-Path $portableLatestDir '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force
        } catch {
            Write-Host "  WARN: could not archive previous portable ($_). Staging will continue; remove or close processes locking files under portable/." -ForegroundColor Yellow
        }

        # Now safe to wipe the directory in preparation for the new staging.
        Remove-Item $portableLatestDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $portableLatestDir) {
            throw "Could not remove $portableLatestDir — close all thecoder.exe instances and retry."
        }
    }

    # -- Step 4b. Stage the fresh build into portable/ -----------------------
    Write-Host "Cloning build directory into staging area (this can take a minute)..."
    # robocopy is dramatically faster than Copy-Item for large directory trees.
    # /MIR mirrors, /NFL/NDL/NJH/NJS keep the log quiet, /NP hides per-file %.
    # Exit codes 0-7 are all success for robocopy; only 8+ means real failure.
    & robocopy $buildOutDir $portableLatestDir /MIR /NFL /NDL /NJH /NJS /NP /MT:16 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0  # robocopy uses non-zero "success" codes which break $ErrorActionPreference downstream

    # Portable marker: the presence of `data\` next to the exe turns VS Code
    # into a fully self-contained, relocatable install (see docs/userdata.md).
    $dataDir = Join-Path $portableLatestDir 'data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $dataDir 'user-data') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $dataDir 'extensions') -Force | Out-Null

    # Friendly readme inside the bundle so end-users know what they have.
    $portableReadme = "TheCoder $versionLabel -- portable build`r`n`r`n" + `
        "Just run ${appName}.exe. All settings, extensions and workspace state are`r`n" + `
        "written into the data\ folder next to the executable, so you can move this`r`n" + `
        "entire directory (or copy it onto a USB stick) and the editor follows.`r`n`r`n" + `
        "Architecture: $Arch`r`n"
    Set-Content -Path (Join-Path $portableLatestDir 'PORTABLE_README.txt') -Value $portableReadme -Encoding UTF8

    # -- Step 4c. Refresh checksums.txt over every archived zip --------------
    $sumLines = Get-ChildItem $portableRoot -Filter '*.zip' -File | Sort-Object Name | ForEach-Object {
        $hh = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash
        "$hh  $($_.Name)"
    }
    if ($sumLines) {
        Set-Content -Path (Join-Path $portableRoot 'checksums.txt') -Value $sumLines -Encoding ASCII
    } else {
        # No archived zips yet (first ever run) -- remove any stale file.
        $stale = Join-Path $portableRoot 'checksums.txt'
        if (Test-Path $stale) { Remove-Item $stale -Force }
    }

    $stageSizeMB = [math]::Round(((Get-ChildItem $portableLatestDir -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)/1MB, 1)
    Write-Host ("  -> portable/  ($stageSizeMB MB unpacked, ready to run)")

    # Stage the in-tree TheCoder copilot customizations (balance, pricing,
    # BYOK helpers) on top of the gulp-baked extension bundle.
    $syncScript = Join-Path $repoRoot 'scripts\sync-copilot-to-portable.ps1'
    if (Test-Path $syncScript) {
        Write-Host "  Syncing extensions/copilot customizations into portable..."
        & powershell -NoProfile -ExecutionPolicy Bypass -File $syncScript
        if ($LASTEXITCODE -ne 0) { throw "sync-copilot-to-portable failed (exit $LASTEXITCODE)" }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Section "Done"
if (-not $SkipInstaller) {
    Write-Host "Installers : $installOutDir" -ForegroundColor Green
    Get-ChildItem $installOutDir | ForEach-Object {
        Write-Host ('  ' + $_.Name + '  (' + [math]::Round($_.Length/1MB,1) + ' MB)')
    }
}
if (-not $SkipPortable) {
    Write-Host "Portable   : $portableLatestDir" -ForegroundColor Green
    Write-Host "             (run thecoder.exe from there)" -ForegroundColor DarkGray
    Write-Host "Archives   : $portableRoot\*.zip" -ForegroundColor Green
    Get-ChildItem $portableRoot -File -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
        Write-Host ('  ' + $_.Name + '  (' + [math]::Round($_.Length/1MB,1) + ' MB)')
    }
}
