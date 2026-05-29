# TheCoder releases

This directory holds packaged builds of TheCoder produced by
[`scripts/build-release.ps1`](../scripts/build-release.ps1). The actual
artifacts (which are 200+ MB each) are gitignored; only this README and the
`.gitkeep` files are checked in so the directory layout is preserved.

## Layout

```
releases/
├── install/
│   └── <version>/
│       ├── TheCoderSetup-x64-<version>.exe        ← system-wide installer (admin)
│       ├── TheCoderUserSetup-x64-<version>.exe    ← per-user installer (no admin)
│       └── checksums.txt
└── portable/
    ├── portable/                                                                  ← ALWAYS the latest, version-less
    │   ├── thecoder.exe                                                            ← just double-click this
    │   ├── data/                                                                   ← portable-mode marker; all user data here
    │   ├── resources/, locales/, ...                                              ← Electron app payload
    │   └── PORTABLE_README.txt
    ├── TheCoder-portable-x64-<oldver>__2026-05-26_18-36-16.zip                    ← previous build, auto-archived on rebuild
    ├── TheCoder-portable-x64-<olderver>__2026-05-26_19-15-02.zip                  ← older build
    └── checksums.txt                                                              ← SHA-256 of every archived .zip
```

The directory `releases/portable/portable/` always contains the most recent
portable build with **no version suffix in its path** — you just run
`thecoder.exe` from there. Whenever a new portable is built, the previous
`portable/` directory is zipped as
`TheCoder-portable-<arch>-<oldver>__<timestamp>.zip` and the timestamped
archive is dropped next to it (NOT inside a per-version subdirectory).
This way only the *replaced* builds are zipped, exactly per spec.

`<version>` is read from `package.json` (currently `1.122.0`). Each build also
appends the short git commit (e.g. `1.122.0+a1b2c3d`) for traceability; the
archived zip recovers that version from the old build's `resources/app/package.json`.

## Build flow

```powershell
# One-shot: builds installer + portable for x64
pwsh -File scripts/build-release.ps1

# Or skip the portable step:
pwsh -File scripts/build-release.ps1 -SkipPortable

# Or skip installers:
pwsh -File scripts/build-release.ps1 -SkipInstaller

# Pick architecture (x64 by default; arm64 also supported if you build on arm64)
pwsh -File scripts/build-release.ps1 -Arch x64
```

The script runs:

1. `npm run gulp vscode-win32-<arch>-min` — full minified app build into
   `..\VSCode-win32-<arch>\` (one level above the repo). Compiles, bundles via
   `minify-vscode`, then packages. The `-ci` sibling task only does the
   packaging step and is meant for CI runs that split compile/package across
   parallel jobs.
2. `npm run gulp vscode-win32-<arch>-inno-updater` — copies `inno_updater.exe`
   and `vcruntime140.dll` into `..\VSCode-win32-<arch>\tools\`.
3. `npm run gulp vscode-win32-<arch>-system-setup` and `…-user-setup` — Inno
   Setup compiles the two installers into `.build\win32-<arch>\{system,user}-setup\`.
4. The script copies the installers into `releases/install/<version>/`.
5. For portable:
   - If `releases/portable/portable/` already exists, the script reads its
     version from `resources/app/package.json` and zips the whole directory
     as `TheCoder-portable-<arch>-<oldver>__<timestamp>.zip` at the parent
     level (`releases/portable/`), then deletes the old directory.
   - The fresh build directory is cloned into `releases/portable/portable/`
     and an empty `data\` folder is added (VS Code's portable-mode marker —
     all user data, extensions, settings live in `data\` instead of `%APPDATA%`).
   - `checksums.txt` in `releases/portable/` is refreshed with SHA-256 hashes
     of every archived zip.
   - The latest build is left UNZIPPED so it's a single double-click away.

## Portable behavior

When a `TheCoder.exe` finds a `data\` folder next to it on startup, all of:

- user settings,
- installed extensions,
- workspace storage,
- caches & logs,

are written under that `data\` folder. Move the unzipped directory anywhere
(USB stick, another machine, second OS install) and the editor takes its full
state with it. Zero registry footprint, zero conflict with a system-installed
VS Code or another TheCoder build.

## Reproducibility

The build is **not** code-signed by default. The `gulp ... --sign` flag is
intentionally omitted; signing requires the Azure-Pipelines `sign-win32.ts`
flow plus a code-signing certificate. Treat the installers and portable zips
as personal/dev artifacts unless you wire signing in.

## Disk usage

A full build needs ~6 GB scratch space:

| Stage                                | Size        |
| ------------------------------------ | ----------- |
| `..\VSCode-win32-x64\`                | ~600 MB     |
| Per installer .exe                    | ~110 MB     |
| `releases/portable/portable/`         | ~1.3 GB     |
| Each archived `*__<timestamp>.zip`    | ~370 MB     |

Archived `*__<timestamp>.zip` files accumulate over time; delete by hand or
script them out by mtime when no longer needed.
