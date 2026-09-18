@echo off
REM Start DocForge on a Windows laptop. Everything runs locally: no internet,
REM no installer, no service. Close this window to stop the portal.

setlocal
set "HERE=%~dp0"
set "NODE_ENV=production"
set "DOCFORGE_HOST=127.0.0.1"
set "DOCFORGE_PORT=8080"
set "DOCFORGE_DB=%LOCALAPPDATA%\DocForge\docforge.db"
set "DOCFORGE_WEB_ROOT=%HERE%web"
set "DOCFORGE_SECURE_COOKIES=0"

REM The first run needs a seed administrator. Set a password here once, start
REM the portal, sign in, then clear this line.
if "%DOCFORGE_ADMIN_PASSWORD%"=="" set "DOCFORGE_ADMIN_EMAIL=admin@localhost"

if not exist "%LOCALAPPDATA%\DocForge" mkdir "%LOCALAPPDATA%\DocForge"

echo Starting DocForge at http://127.0.0.1:%DOCFORGE_PORT%
start "" "http://127.0.0.1:%DOCFORGE_PORT%"
"%HERE%node\node.exe" --disable-warning=ExperimentalWarning "%HERE%server.mjs"
endlocal
