# TheCoder — instrukcja buildu (Windows) dla agenta / nowej maszyny

Ten dokument jest **źródłem prawdy** dla każdego, kto po sklonowaniu forka z GitHuba ma zbudować **portable TheCoder** na czystym Windowsie.  
Skierowany do **agenta AI** i człowieka — krok po kroku, z wersjami narzędzi, weryfikacją i znanymi pułapkami.

**Repo:** `https://github.com/ussdeveloper/vscode.git` (fork; **nie** pushować do `microsoft/vscode`).  
**Branch z pełnym TheCoder:** `the-coder-dev` (lub inny wskazany przez użytkownika).  
**Skrypt release:** [`scripts/build-release.ps1`](scripts/build-release.ps1).

---

## Szybka checklista (agent — wykonaj po kolei)

```powershell
# 0. Wymagania: Windows 10/11 x64, ~6 GB dysku, 16 GB RAM zalecane, VS 2022 + SDK, Git

# 1. Klon (przykład)
git clone https://github.com/ussdeveloper/vscode.git C:\work\vscode-local
cd C:\work\vscode-local
git fetch origin the-coder-dev
git checkout the-coder-dev

# 2. Node z .nvmrc (OBOWIĄZKOWE przy npm install)
#    Odczytaj wersję:  Get-Content .nvmrc
nvm install 24.15.0
nvm use 24.15.0
node -v    # v24.15.0 lub nowszy patch, major 24
npm -v     # musi być < 12 (np. 10.x)

# 3. Zamknij wszystkie thecoder.exe
Get-Process thecoder -ErrorAction SilentlyContinue | Stop-Process -Force

# 4. Zależności (pierwszy raz: 15–45 min)
npm install

# 5. Pełny portable (20–50 min kompilacji + staging)
pwsh -File scripts/build-release.ps1 -PortableOnly
# Jeśli brak pwsh: powershell -NoProfile -File scripts/build-release.ps1 -PortableOnly

# 6. Uruchom wynik
& .\releases\portable\portable\thecoder.exe
```

Po buildzie **zrestartuj** `thecoder.exe` — stary proces nie przeładuje `extension.js` z copilot.

---

## Co jest w repozytorium, a czego nie ma

| W git | Poza git (budujesz lokalnie) |
|-------|------------------------------|
| Źródła, `scripts/build-release.ps1`, `product.json`, branding | `releases/portable/portable/` (~1,3 GB) |
| `releases/portable/.gitkeep`, `releases/README.md` | `releases/portable/*.zip` (archiwum) |
| `node_modules/` po `npm install` | `<parent-repo>\VSCode-win32-x64\` (~600 MB) |

`.gitignore` ignoruje m.in. `releases/portable/portable/`, zipy, `.build-portable-log.txt`, `.thecoder/`.

---

## Wymagania środowiska (szczegółowo)

### System operacyjny

| Parametr | Wartość |
|----------|---------|
| OS | **Windows 10/11**, edycja x64 |
| Architektura buildu | Domyślnie **x64** (`-Arch x64`). `-Arch arm64` tylko na Windows ARM |
| Dysk wolny | **≥ 6 GB** (repo + `node_modules` + `..\VSCode-win32-x64` + portable + ewentualne zipy) |
| RAM | **8 GB** minimum, **16 GB** zalecane przy pełnym `vscode-win32-x64-min` |
| Czas (pierwszy raz) | **20–50 min** sam krok gulp `min`; `npm install` dodatkowo **15–45 min** |

### Wersje narzędzi (sprawdź w repo, nie z pamięci)

| Narzędzie | Wymagana wersja | Jak sprawdzić |
|-----------|-----------------|---------------|
| **Node.js** | **`v24.15.0`** lub nowszy **patch** z **major 24** — patrz [`.nvmrc`](.nvmrc) | `node -v` |
| **npm** | **&lt; 12.0.0** (np. 10.x dołączony do Node 24) | `npm -v` — `preinstall` odrzuca npm ≥ 12 |
| **Git** | dowolna aktualna | `git --version` — etykieta buildu `1.122.0+<short-sha>` |
| **PowerShell** | **7+ (`pwsh`) zalecane**; działa też **Windows PowerShell 5.1** jeśli skrypt nie ma znaków Unicode poza ASCII | `pwsh -v` lub `$PSVersionTable` |

`scripts/build-release.ps1` ustawia `VSCODE_SKIP_NODE_VERSION_CHECK=1` na czas gulp — **nie** pomija to wymagań przy `npm install` w korzeniu repo.

### Visual Studio 2022 (obowiązkowe do `npm install` / native modules)

Zainstaluj **Visual Studio 2022** (Community wystarczy) z:

- **Desktop development with C++**
- **MSVC v143** (lub aktualny toolset x64/x86 build tools)
- **Windows 10/11 SDK** (dowolna nowsza 10.0.x)
- **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs** — bez tego `node-gyp` często kończy się **MSB8040** / błędem Spectre

Pomocniczy skrypt w repo (dostosuj ścieżkę VS w pliku, jeśli nie masz Community):

```cmd
.tmp-install-spectre.cmd
```

Log: `.tmp-install-spectre.log`.

### Windows SDK — `signtool.exe`

Potrzebny na **końcu** pakowania (`patchWin32DependenciesTask`). Typowa ścieżka:

```text
C:\Program Files (x86)\Windows Kits\10\bin\10.0.<wersja>\x64\signtool.exe
```

`build-release.ps1` na starcie **sam dopina** najnowszy SDK do `PATH`, jeśli `signtool` nie jest widoczny. Bez SDK build pada z **ENOENT** przy `signtool`.

### Opcjonalne / warunkowe

| Narzędzie | Kiedy potrzebne |
|-----------|-----------------|
| **Python 3** | Czasem wymagany przez `node-gyp` (jeśli `postinstall` tego żąda) |
| **Inno Setup** | Tylko przy buildzie **instalatorów** (bez `-PortableOnly`) — gulp używa `innosetup` z `node_modules` |
| **7-Zip** | Nie do portable; opcjonalnie do ręcznego rozpakowania archiwów |

### Czego **nie** instalować na ścieżce portable

- Nie trzeba osobnego Node na maszynie docelowej **użytkownika** portable — Electron ma własny runtime.
- Nie mieszaj ze starym `Code.exe` / inną kopią VS Code — uruchamiaj wyłącznie `releases\portable\portable\thecoder.exe`.

---

## Przygotowanie repozytorium (nowa maszyna)

### 1. Klon i branch

```powershell
git clone https://github.com/ussdeveloper/vscode.git <ścieżka-repo>
cd <ścieżka-repo>
git checkout the-coder-dev
git pull origin the-coder-dev
```

**Bezpieczeństwo forków:** `git push` tylko na `origin` (`ussdeveloper/vscode`). Remote `upstream` (microsoft) ma zablokowany push.

### 2. Node i npm

```powershell
cd <ścieżka-repo>
Get-Content .nvmrc          # np. 24.15.0
nvm install (Get-Content .nvmrc).Trim()
nvm use (Get-Content .nvmrc).Trim()
node -v
npm -v                    # musi być 10.x lub 11.x, NIE 12+
```

### 3. Zamknij TheCoder przed install/build

Uruchomiony `thecoder.exe` trzyma locki na:

- `extensions\copilot\...\runtime.node`
- `releases\portable\portable\data\user-data\state.vscdb`

Skutek: **`EPERM` / `EBUSY`** w `postinstall` lub przy usuwaniu starego portable.

```powershell
Get-Process thecoder -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 4
Get-Process thecoder -ErrorAction SilentlyContinue | Stop-Process -Force
```

`build-release.ps1` robi to sam na starcie — i tak lepiej zamknąć wcześniej.

### 4. `npm install` (korzeń repo)

```powershell
cd <ścieżka-repo>
npm install
```

- Pierwszy raz: długo; wymaga VS + Spectre.
- Przy błędzie w połowie: napraw środowisko, potem `npm install` ponownie (ew. `node build/npm/fast-install.ts --force` jeśli stan postinstall jest uszkodzony — patrz komunikat w logu).

### 5. (Zalecane przed pierwszym pełnym buildem) Copilot w drzewie

```powershell
cd extensions\copilot
npm install
npm run build
cd ..\..
```

Pełny gulp i tak buduje copilot; osobny build przyspiesza debug i sync.

---

## Pełny build portable (główna ścieżka)

### Komenda

Z **korzenia repo**:

```powershell
pwsh -NoProfile -File scripts/build-release.ps1 -PortableOnly
```

`-PortableOnly` = pomija instalatory Inno, robi: min build → staging portable → sync copilot.

**Bez `pwsh` na maszynie:**

```powershell
powershell -NoProfile -File scripts/build-release.ps1 -PortableOnly
```

Skrypt musi być zapisany w **UTF-8 bez BOM** i używać **ASCII** w stringach PowerShell (patrz sekcja problemów — znaki typu `—` psują parser w PS 5.1).

### Kolejność kroków skryptu

| Krok | Akcja | Wynik |
|------|--------|--------|
| 0 | `Stop-TheCoderProcesses` | Zwolnienie locków |
| 0 | `Ensure-SigntoolOnPath` | SDK na PATH |
| 1 | `npm run gulp -- vscode-win32-x64-min` | Katalog **obok repo**: `<parent>\VSCode-win32-x64\` |
| 2 | `vscode-win32-x64-inno-updater` | `tools\inno_updater.exe`, `vcruntime140.dll` w paczce |
| 3 | (pominięty przy `-PortableOnly`) | Instalatory w `releases\install\<wersja>\` |
| 4a | Zip starego `releases\portable\portable\` | `TheCoder-portable-x64-<stara>__YYYY-MM-DD_HH-mm-ss.zip` |
| 4b | `robocopy` → `releases\portable\portable\` | Świeży portable + `data\` |
| 4c | `PORTABLE_README.txt`, `checksums.txt` | Metadane |
| 4d | `scripts\sync-copilot-to-portable.ps1` | Najnowszy `extensions/copilot` → `resources\app\extensions\copilot\` |

### Gdzie jest wynik

```text
<repo>\releases\portable\portable\
├── thecoder.exe              ← uruchom to
├── data\                     ← marker trybu portable
│   ├── user-data\
│   └── extensions\
├── resources\app\
└── PORTABLE_README.txt
```

Surowy output gulp (przed kopiowaniem):

```text
<parent-of-repo>\VSCode-win32-x64\
```

Przykład: repo `D:\dev\vscode-local` → build `D:\dev\VSCode-win32-x64\`.

Etykieta wersji w logu: `<package.json version>+<git short sha>`, np. `1.122.0+5717babe2d3`.

### Log buildu (opcjonalnie)

```powershell
powershell -NoProfile -File scripts/build-release.ps1 -PortableOnly *>&1 `
  | Tee-Object -FilePath .build-portable-log.txt -Append
```

Plik logu jest w `.gitignore`.

---

## Szybsze ścieżki (po pierwszym udanym buildzie)

### A) Tylko zmiany w `extensions/copilot`

Wymaga istniejącego `releases\portable\portable\`:

```powershell
pwsh -File scripts/sync-copilot-to-portable.ps1
```

Skrypt: `npm run build` w copilot → kopiuje `package.json` + `dist\` → weryfikuje m.in. `configureDeepSeekApiKey` w `extension.js` i brak `DeepSeekBalanceProvider`.

### B) Przepakowanie bez rekompilacji workbencha

Gdy `<parent>\VSCode-win32-x64\` jest aktualny:

```powershell
pwsh -File scripts/build-release.ps1 -SkipBuild -PortableOnly
```

**Nie** przebuduje `src/` — tylko skopiuje istniejący output i zsyncuje copilot.

### C) Tylko instalatory

```powershell
pwsh -File scripts/build-release.ps1 -SkipPortable
```

---

## Co wymaga pełnego buildu vs sync

| Zmienione | Wystarczy |
|-----------|-----------|
| `extensions/copilot/**` | `sync-copilot-to-portable.ps1` (po pierwszym pełnym buildzie) |
| `src/**`, `product.json`, branding, inne `extensions/*` | Pełny `build-release.ps1` **bez** `-SkipBuild` |
| `scripts/build-release.ps1` | Pełny build (staging) |

---

## Weryfikacja po buildzie (agent)

1. **Plik istnieje:** `releases\portable\portable\thecoder.exe`
2. **Rozmiar unpacked:** ~1,0–1,5 GB
3. **Wersja:**
   ```powershell
   (Get-Content releases\portable\portable\resources\app\package.json | ConvertFrom-Json).version
   git rev-parse --short HEAD
   ```
4. **Sync copilot** — w logu syncu:
   - `extension.js has configureDeepSeekApiKey : True`
   - `extension.js has no DeepSeekBalanceProvider : True`
5. **Workbench (terminal sensitive input)** — w paczce nie powinno być starych stringów:
   ```powershell
   Select-String -Path releases\portable\portable\resources\app\out\**\*.js `
     -Pattern "registerSensitive|SensitiveInputElicitation" -SimpleMatch
   ```
   Oczekiwane: **0 trafień** na branchu `the-coder-dev`.
6. **Nie uruchamiaj starego exe** z poprzedniego portable ani z `VSCode-win32-x64` — tylko `releases\portable\portable\thecoder.exe`.

---

## Znane problemy i rozwiązania (doświadczenie z buildów forka)

### Blokady plików / EPERM / EBUSY

| Objaw | Przyczyna | Rozwiązanie |
|-------|-----------|-------------|
| `EPERM` przy `postinstall`, czyszczeniu copilot | Działa `thecoder.exe` (dev/portable/instalator) | `Stop-Process`; odczekaj 4 s; powtórz |
| `Could not remove ...\releases\portable\portable` | Ten sam proces + otwarty `state.vscdb` | Zamknij TheCoder; zamknij Explorer w tym folderze |
| `Compress-Archive` / WARN przy archiwizacji | `runtime.node` lub inne pliki zablokowane | WARN jest nieblokujący — staging idzie dalej; przy pełnym fail zamknij procesy |

### Visual Studio / node-gyp

| Objaw | Rozwiązanie |
|-------|-------------|
| MSB8040 / Spectre | Doinstaluj Spectre-mitigated libs lub `.tmp-install-spectre.cmd` |
| `node-gyp` nie znajduje VS | Uruchom **x64 Native Tools Command Prompt for VS 2022** i stamtąd `npm install`, albo upewnij się, że `vswhere` widzi instalację |

### SDK / signtool

| Objaw | Rozwiązanie |
|-------|-------------|
| ENOENT `signtool` na końcu `package-win32-x64` | Zainstaluj Windows 10/11 SDK; sprawdź log pre-flight w build-release |
| WARNING pre-flight o braku SDK | Build **prawdopodobnie** padnie na kroku 1 — doinstaluj SDK przed startem |

### PowerShell / skrypt release

| Objaw | Przyczyna | Rozwiązanie |
|-------|-----------|-------------|
| `Unexpected token 'close'` w `build-release.ps1` | Znak **em dash** `—` lub **BOM UTF-8** w pliku `.ps1` pod **Windows PowerShell 5.1** | Użyj aktualnego skryptu z repo (`the-coder-dev`); uruchamiaj przez `pwsh` 7+; stringi w skrypcie muszą być ASCII (`-` zamiast `—`) |
| `$stageSizeMB MB` parser error | W PS 5.1 `$var MB` w cudzysłowie `"..."` jest błędnie parsowane | Naprawione w repo przez konkatenację stringów — `git pull` |

### npm / Node

| Objaw | Rozwiązanie |
|-------|-------------|
| `Please use Node.js v24.15.0...` przy `npm install` | `nvm use` zgodnie z `.nvmrc` |
| `Please use npm version < 12` | `npm i -g npm@10` lub użyj npm dołączonego do Node 24 |
| Build gulp działa na „złym” Node | Ustaw Node 24 przed `npm install`; gulp i tak ma skip check, ale **postinstall** musi przejść na właściwym Node |

### „Stary” TheCoder mimo świeżego buildu

| Objaw | Przyczyna | Rozwiązanie |
|-------|-----------|-------------|
| Dialog „Terminal is waiting for sensitive input” | Uruchomiono **starą** kopię portable / stary `VSCode-win32-x64` | Tylko `releases\portable\portable\thecoder.exe`; sprawdź `LastWriteTime` exe |
| Stare funkcje BYOK / balance | Stary `dist` w copilot bez sync | `sync-copilot-to-portable.ps1` + **restart** exe |
| Ostrzeżenie corrupt install | Stary build bez `skipIntegrityCheck` w `product.json` | Pełny rebuild z aktualnego brancha |

### Portable / ustawienia (runtime, nie build)

| Objaw | Uwaga |
|-------|--------|
| `Can not add index to parent of type array` przy utility models | `settings.json` miał root `[]` zamiast `{}` — naprawione w kodzie (`coerceSettingsObjectRoot`); po przeniesieniu profilu sprawdź `data\user-data\User\settings.json` |
| Klucze API BYOK po przeniesieniu na inny PC | Windows DPAPI — klucze mogą wymagać ponownego wpisania |

### Czas / zasoby

| Objaw | Uwaga |
|-------|--------|
| Krok 1 „wisi” 30+ min | Normalne przy pierwszym `min` — nie przerywaj w połowie `postinstall` ani gulp |
| OOM / Node heap | Gulp ustawia `--max-old-space-size=8192`; zamknij inne aplikacje zjadające RAM |

---

## Parametry `build-release.ps1`

```powershell
pwsh -File scripts/build-release.ps1 [-Arch x64|arm64] [-SkipBuild] [-SkipInstaller] [-SkipPortable] [-PortableOnly]
```

| Parametr | Znaczenie |
|----------|-----------|
| `-Arch x64` | Domyślnie x64 |
| `-SkipBuild` | Pomija gulp min — wymaga gotowego `<parent>\VSCode-win32-<arch>\` |
| `-SkipInstaller` | Bez Inno Setup |
| `-SkipPortable` | Bez `releases/portable/portable/` |
| `-PortableOnly` | Instalatory wyłączone, tylko portable |

---

## Tożsamość produktu (fork)

[`product.json`](product.json):

- `nameShort`: `thecoder` → `thecoder.exe`
- `dataFolderName`: `.thecoder`
- `win32DirName`: `TheCoder`
- `skipIntegrityCheck`: `true` (portable dev bez oficjalnego podpisu)

Ikony: `resources\win32\code.ico` (+ PNG w `resources\win32\`). Branding dodatkowy: `.branding\`.

---

## Tryb portable

Folder `data\` obok `thecoder.exe` przełącza profil z `%APPDATA%` na:

```text
data\user-data\     ← settings, state.vscdb
data\extensions\    ← rozszerzenia użytkownika
```

Cały katalog `portable\` można przenosić (USB, inny PC). Patrz też [`.cursor/extra-docs/`](.cursor/extra-docs/) dla zachowania TheCoder (BYOK, terminal, vision).

---

## Git i artefakty

- **Nie commituj** zbudowanego portable ani `.7z` — są ignorowane.
- **Push** tylko na `origin` (`ussdeveloper/vscode`), nigdy na `upstream` (Microsoft).

---

## Powiązane pliki

| Plik | Rola |
|------|------|
| [`scripts/build-release.ps1`](scripts/build-release.ps1) | Główny pipeline |
| [`scripts/sync-copilot-to-portable.ps1`](scripts/sync-copilot-to-portable.ps1) | Szybki deploy copilot |
| [`releases/README.md`](releases/README.md) | Layout katalogów |
| [`.nvmrc`](.nvmrc) | Wymagana wersja Node |
| [`product.json`](product.json) | Nazwy, portable, gallery Open VSX |
| [`.cursor/extra-docs/`](.cursor/extra-docs/) | Notatki behawioralne TheCoder |

Upstream (ogólny VS Code): [How to Contribute — Build](https://github.com/microsoft/vscode/wiki/How-to-Contribute).

---

## Szablon raportu dla agenta (po buildzie)

Wklej użytkownikowi:

```text
Branch: <nazwa> @ <short-sha>
Node: <node -v>  npm: <npm -v>
Build: OK / FAIL (krok: ...)
Portable: <abs-path>\releases\portable\portable\thecoder.exe
Exe modified: <LastWriteTime>
Sync copilot: configureDeepSeekApiKey=<T/F>  no DeepSeekBalanceProvider=<T/F>
Sensitive strings in bundle: <count> (oczekiwane 0)
```
