@echo off
cd /d "%~dp0"
echo Starting at %DATE% %TIME% > .tmp-install-spectre.log
echo Args used: --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --quiet --norestart --wait >> .tmp-install-spectre.log
"C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --quiet --norestart --wait >> .tmp-install-spectre.log 2>&1
echo SetupExitCode=%ERRORLEVEL% >> .tmp-install-spectre.log
echo Finished at %DATE% %TIME% >> .tmp-install-spectre.log
exit /b %ERRORLEVEL%
