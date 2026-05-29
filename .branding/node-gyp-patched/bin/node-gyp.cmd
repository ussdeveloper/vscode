@echo off
setlocal
node "%~dp0node-gyp.js" %*
endlocal
exit /b %ERRORLEVEL%
