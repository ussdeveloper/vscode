# TheCoder — budowanie wersji portable (Windows)

Ten dokument opisuje **krok po kroku**, jak z tego forka (`ussdeveloper/vscode`) zbudować **rozpakowaną wersję portable** TheCoder na Windows.  
Oficjalny skrypt: [`scripts/build-release.ps1`](scripts/build-release.ps1). Krótszy opis katalogów: [`releases/README.md`](releases/README.md).

---

## Co dostajesz na końcu

Po udanym buildzie **najnowsza** portable leży zawsze tutaj (ścieżka **bez numeru wersji** w nazwie folderu):

```text
<repo>\releases\portable\portable\
├── thecoder.exe              ← uruchamiasz to
├── data\                     ← marker trybu portable (ustawienia, rozszerzenia, cache)
│   ├── user-data\
│   └── extensions\
├── resources\app\            ← workbench + wbudowane rozszerzenia (w tym copilot)
├── locales\, tools\, ...
└── PORTABLE_README.txt
```

Poprzedni build (jeśli był) jest automatycznie archiwizowany jako zip obok:

```text
<repo>\releases\portable\TheCoder-portable-x64-<stara-wersja>__YYYY-MM-DD_HH-mm-ss.zip
```

Surowy wynik kompilacji gulp (przed skopiowaniem do `releases/`) ląduje **jeden poziom wyżej niż repo**:

```text
<parent-of-repo>\VSCode-win32-x64\
├── thecoder.exe
└── ... (pełna aplikacja Electron, ~600 MB)
```

Przykład: repo `C:\Users\sulaco\Desktop\vscode-local` → build output `C:\Users\sulaco\Desktop\VSCode-win32-x64\`.

---

## Wymagania (przed pierwszym buildem)

### System

| Wymaganie | Szczegóły |
|-----------|-----------|
| **OS** | Windows 10/11 (x64). Build x64 na maszynie x64. `arm64` tylko jeśli budujesz na Windows ARM. |
| **Dysk** | ~**6 GB** wolnego (build tymczasowy + portable ~1,3 GB + ewentualne zipy archiwum). |
| **RAM** | 8 GB minimum, **16 GB** zalecane przy pełnym `min` build. |
| **Czas** | Pierwszy pełny build: zwykle **20–50 minut** (zależy od CPU i dysku). |

### Oprogramowanie

1. **PowerShell 7+** (`pwsh`) — skrypt release jest napisany pod PowerShell, nie Windows PowerShell 5.1.
   - Instalacja: [PowerShell](https://github.com/PowerShell/PowerShell/releases)

2. **Node.js 22.22.1** (zgodnie z [`.nvmrc`](.nvmrc)):
   ```powershell
   # Przykład z nvm-windows:
   nvm install 22.22.1
   nvm use 22.22.1
   node -v   # powinno pokazać v22.22.1
   ```

3. **Git** — do `git rev-parse` (etykieta wersji `1.122.0+a1b2c3d`).

4. **Visual Studio 2022** (Community wystarczy) z komponentami do natywnych modułów Node:
   - **Desktop development with C++**
   - **MSVC v143** (lub aktualny toolset x64/x86)
   - **Windows 10/11 SDK**
   - **Spectre-mitigated libs** — bez tego `node-gyp` często pada na `msvs_version` / linkowaniu. W repo jest pomocniczy skrypt:
     ```cmd
     .tmp-install-spectre.cmd
     ```
     (modyfikuje VS 2022 Community — ścieżkę dostosuj w pliku, jeśli masz inną edycję/ścieżkę).

5. **Windows 10 SDK — `signtool.exe`** na `PATH` (lub w standardowej lokalizacji):
   - `C:\Program Files (x86)\Windows Kits\10\bin\10.0.*\x64\signtool.exe`
   - Skrypt `build-release.ps1` **sam dopina** najnowszy SDK do `PATH`, jeśli `signtool` nie jest widoczny. Bez SDK build często pada na końcu przy `patchWin32DependenciesTask`.

6. **Inno Setup** — tylko jeśli budujesz **instalatory** (nie jest potrzebny do samego portable). W projekcie jest zależność npm `innosetup`; gulp uruchamia kompilator z `node_modules`.

7. **Python 3** — czasem wymagany przez `node-gyp` (jeśli `postinstall` tego wymaga).

### Tożsamość produktu (fork)

Nazwy i foldery danych są w [`product.json`](product.json), m.in.:

- `nameShort`: `thecoder` → plik `thecoder.exe`
- `dataFolderName`: `.thecoder`
- `win32DirName`: `TheCoder`

Ikony Windows: `resources\win32\code.ico` (oraz powiązane PNG w `resources\win32\`).  
Jeśli zmieniasz branding, zaktualizuj te pliki **przed** pełnym buildem gulp.

---

## Jednorazowa przygotowanie repozytorium

Wszystkie kroki wykonuj w **korzeniu repo** (tam gdzie jest `package.json`).

### 1. Zamknij działające TheCoder

Uruchomiony `thecoder.exe` (dev, portable lub z instalatora) **blokuje pliki** w `extensions\copilot` i w `releases\portable\portable\data\` — build wtedy kończy się `EPERM`.

```powershell
Get-Process thecoder -ErrorAction SilentlyContinue | Stop-Process -Force
```

Skrypt release robi to sam na starcie, ale lepiej zamknąć ręcznie wcześniej.

### 2. Zainstaluj zależności npm (root)

```powershell
cd C:\Users\sulaco\Desktop\vscode-local   # ← twoja ścieżka repo

# Pierwszy raz / po zmianie package-lock:
npm install
```

To uruchamia `preinstall` + `postinstall` (m.in. natywne moduły, rozszerzenia). **Może trwać długo** i wymaga działającego VS + Spectre libs.

### 3. (Zalecane) Zbuduj rozszerzenie Copilot w drzewie

TheCoder-specific logika (BYOK, ceny, balance, vision) jest w `extensions/copilot/`. Pełny gulp wbuduje copilot w paczkę, ale **po każdej zmianie tylko w copilot** szybciej zsynchronizować portable skryptem sync (patrz niżej).

```powershell
cd extensions\copilot
npm install    # pierwszy raz w tym podkatalogu
npm run build
cd ..\..
```

---

## Pełny build portable (główna ścieżka)

### Komenda

Z korzenia repo, w **PowerShell 7**:

```powershell
cd C:\Users\sulaco\Desktop\vscode-local

pwsh -File scripts/build-release.ps1 -PortableOnly
```

`-PortableOnly` = to samo co `-SkipInstaller` — **pomija instalatory Inno**, robi tylko build aplikacji + staging portable (+ sync copilot).

Bez flag (installer + portable):

```powershell
pwsh -File scripts/build-release.ps1
```

### Co robi skrypt (kolejność)

| Krok | Gulp / akcja | Wynik |
|------|----------------|-------|
| **0** | Zabija procesy `thecoder` | Zwolnienie locków |
| **0** | `Ensure-SigntoolOnPath` | SDK na PATH |
| **1** | `npm run gulp -- vscode-win32-x64-min` | `..\VSCode-win32-x64\` z `thecoder.exe` |
| **2** | `vscode-win32-x64-inno-updater` | `tools\inno_updater.exe`, `vcruntime140.dll` w paczce |
| **3** | (pominięty przy `-PortableOnly`) | Instalatory w `releases\install\` |
| **4a** | Archiwizacja starego `releases\portable\portable\` → zip | `TheCoder-portable-x64-...__timestamp.zip` |
| **4b** | `robocopy` z `VSCode-win32-x64` → `releases\portable\portable\` | Świeży portable |
| **4c** | Tworzy puste `data\`, `data\user-data\`, `data\extensions\` | Włączenie trybu portable |
| **4d** | `PORTABLE_README.txt` | Opis dla użytkownika |
| **4e** | `scripts\sync-copilot-to-portable.ps1` | Najnowszy `extensions/copilot` → `resources\app\extensions\copilot\` |

Ustawiane jest też `VSCODE_SKIP_NODE_VERSION_CHECK=1` (tsx/gulp).

### Uruchomienie gotowej wersji

```powershell
& "C:\Users\sulaco\Desktop\vscode-local\releases\portable\portable\thecoder.exe"
```

Albo dwuklik w Explorerze na `thecoder.exe` w tym folderze.

**Ważne:** Po syncie copilot **zrestartuj** TheCoder — stary proces nie przeładuje `extension.js`.

---

## Szybsze ścieżki (gdy pełny build już był)

### A) Tylko zmiany w `extensions/copilot` (bez 30+ min gulp)

Wymaga **istniejącego** `releases\portable\portable\`:

```powershell
cd C:\Users\sulaco\Desktop\vscode-local
pwsh -File scripts/sync-copilot-to-portable.ps1
```

Skrypt:

1. `npm run build` w `extensions\copilot`
2. Kopiuje `package.json` + `dist\` do  
   `releases\portable\portable\resources\app\extensions\copilot\`
3. Weryfikuje m.in. `thecoder.balance.apiKey` i `configureDeepSeekApiKey` w zbudowanych plikach

Potem uruchom ponownie `thecoder.exe` z `releases\portable\portable\`.

### B) Przepakowanie portable z ostatniego `VSCode-win32-x64` (bez rekompilacji)

Gdy katalog `..\VSCode-win32-x64\` jest już aktualny:

```powershell
pwsh -File scripts/build-release.ps1 -SkipBuild -PortableOnly
```

To **nie** przebuduje TypeScript/workbencha — tylko skopiuje istniejący output do `releases\portable\portable\` i uruchomi sync copilot.

### C) Tylko instalatory (bez portable)

```powershell
pwsh -File scripts/build-release.ps1 -SkipPortable
```

---

## Zmiany w workbench (`src/`) — kiedy potrzebny pełny build

| Zmienione | Wystarczy |
|-----------|-----------|
| `extensions/copilot/**` | `sync-copilot-to-portable.ps1` (po pierwszym pełnym buildzie) |
| `src/**`, `product.json`, branding, inne `extensions/*` | Pełny `build-release.ps1` (bez `-SkipBuild`) |
| Ustawienia workbench / contributions w `src/vs/workbench/**` | Pełny build |

---

## Tryb portable — jak to działa

Jeśli obok `thecoder.exe` istnieje folder **`data\`**, TheCoder **nie** zapisuje profilu w `%APPDATA%`, tylko w:

```text
releases\portable\portable\data\
├── user-data\     ← settings, state.vscdb, cache
└── extensions\    ← rozszerzenia użytkownika
```

Możesz skopiować cały katalog `portable\` na pendrive / inny PC.  
**Uwaga:** klucze API BYOK na Windows są szyfrowane DPAPI **per maszyna** — po przeniesieniu na inny komputer klucze mogą być nie do odczytania (fork pokazuje wtedy monit o ponowne wpisanie klucza).

---

## Weryfikacja po buildzie

1. **Rozmiar** — unpacked portable ~**1,0–1,5 GB** (zależnie od wersji).
2. **Plik** — `releases\portable\portable\thecoder.exe` istnieje.
3. **Copilot / TheCoder** — po syncie w konsoli skryptu:
   - `package.json has thecoder.balance.apiKey : True`
   - `extension.js has configureDeepSeekApiKey : True`
4. **Wersja** — w aplikacji: Help → About, lub:
   ```powershell
   (Get-Content releases\portable\portable\resources\app\package.json | ConvertFrom-Json).version
   ```
5. **Archiwum** — przy drugim buildzie w `releases\portable\` pojawia się zip poprzedniej wersji + `checksums.txt` (SHA-256 zipów).

---

## Typowe błędy i rozwiązania

| Objaw | Przyczyna | Co zrobić |
|-------|-----------|-----------|
| `EPERM` / `EBUSY` przy `postinstall` lub czyszczeniu copilot | Działa `thecoder.exe` | Zamknij wszystkie instancje; uruchom build ponownie |
| `node-gyp` / Spectre / MSB8040 | Brak Spectre libs w VS | Uruchom `.tmp-install-spectre.cmd` lub doinstaluj komponent w Visual Studio Installer |
| `signtool` / ENOENT na końcu pakowania | Brak Windows SDK | Zainstaluj Windows 10/11 SDK; sprawdź log pre-flight w `build-release.ps1` |
| `Expected thecoder.exe inside VSCode-win32-x64` | Krok 1 nie zakończony lub `-SkipBuild` bez folderu | Usuń `-SkipBuild` lub dokończ `npm run gulp -- vscode-win32-x64-min` |
| `sync-copilot-to-portable failed` | Brak `releases\portable\portable` | Najpierw pełny build bez `-SkipBuild` |
| Stare funkcje TheCoder w UI | Stary `dist` w portable | `sync-copilot-to-portable.ps1` + restart exe |
| Build trwa „w nieskończoność” | Normalne przy pierwszym `min` | Czekaj; monitoruj CPU/dysk; nie przerywaj w połowie `postinstall` |

Logi gulp: terminal, w którym uruchomiłeś `build-release.ps1`.  
Dodatkowo możesz ręcznie sprawdzić krok 1:

```powershell
npm run gulp -- vscode-win32-x64-min
```

---

## Parametry `build-release.ps1` (pełna lista)

```powershell
pwsh -File scripts/build-release.ps1 [-Arch x64|arm64] [-SkipBuild] [-SkipInstaller] [-SkipPortable] [-PortableOnly]
```

| Parametr | Znaczenie |
|----------|-----------|
| `-Arch x64` | Domyślnie x64. `arm64` tylko na Windows ARM. |
| `-SkipBuild` | Pomija gulp `vscode-win32-*-min` — wymaga gotowego `..\VSCode-win32-<arch>\`. |
| `-SkipInstaller` | Bez Inno Setup (system + user). |
| `-SkipPortable` | Bez katalogu `releases\portable\portable\`. |
| `-PortableOnly` | `-SkipInstaller` + portable (najczęstszy wariant dla USB). |

---

## Podpis kodu (opcjonalnie)

Domyślnie build **nie** jest podpisywany (`--sign` nie jest używany). Portable i instalatory są artefaktami deweloperskimi. Podpis wymaga infrastruktury Microsoft / certyfikatu — poza zakresem tego dokumentu.

---

## Git a artefakty

W [`.gitignore`](.gitignore) ignorowane są m.in.:

- `releases/portable/portable/`
- `releases/portable/*.zip`
- `releases/install/*/`

Do repo trafiają tylko szkielety katalogów i [`releases/README.md`](releases/README.md). **Portable budujesz lokalnie**, nie z git clone.

---

## Skrócona checklista (copy-paste)

```powershell
# 1. Środowisko
nvm use 22.22.1
cd C:\Users\sulaco\Desktop\vscode-local

# 2. Zamknij TheCoder
Get-Process thecoder -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Zależności (rzadko — po pull z lockfile)
npm install

# 4. PEŁNY portable (długo, ~20–50 min)
pwsh -File scripts/build-release.ps1 -PortableOnly

# 5. Uruchom
& .\releases\portable\portable\thecoder.exe

# --- Później: tylko zmiany w extensions/copilot ---
pwsh -File scripts/sync-copilot-to-portable.ps1
# Restart thecoder.exe
```

---

## Powiązane pliki

| Plik | Rola |
|------|------|
| [`scripts/build-release.ps1`](scripts/build-release.ps1) | Główny pipeline release |
| [`scripts/sync-copilot-to-portable.ps1`](scripts/sync-copilot-to-portable.ps1) | Szybki deploy copilot → portable |
| [`releases/README.md`](releases/README.md) | Layout katalogów i rozmiary |
| [`product.json`](product.json) | Nazwa `thecoder`, foldery danych |
| [`.cursor/extra-docs/`](.cursor/extra-docs/) | Notatki o zachowaniu TheCoder (ceny, vision, itd.) |

Upstream (ogólny build VS Code): [How to Contribute — Build](https://github.com/microsoft/vscode/wiki/How-to-Contribute).
