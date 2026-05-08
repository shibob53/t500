@echo off
title Midasbuy Init Login
setlocal

cd /d "%~dp0"

echo === Midasbuy Init Login ===
echo This opens a visible browser window. Sign in once, press Enter here, done.
echo Cookies persist in .midasbuy-profile/ — you only need to do this once.
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    echo Install Node.js 18+ from https://nodejs.org/ then re-run this script.
    pause
    exit /b 1
)

if not exist "node_modules\playwright" (
    echo Installing dependencies first...
    call npm install
    if errorlevel 1 ( pause & exit /b 1 )
)

if not exist "%LOCALAPPDATA%\ms-playwright" (
    echo Downloading Playwright Chromium...
    call npx playwright install chromium
    if errorlevel 1 ( pause & exit /b 1 )
)

node midasbuy-hybrid.js init-login

echo.
echo Done. You can now double-click start-daemon.bat to run the daemon.
pause
endlocal
