@echo off
title Midasbuy Hybrid Daemon
setlocal

REM Always run from this script's own directory, regardless of where it's
REM invoked from (matters if someone puts a shortcut on the desktop).
cd /d "%~dp0"

echo === Midasbuy Hybrid Daemon ===
echo.

REM --- Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    echo Install Node.js 18+ from https://nodejs.org/ then re-run this script.
    echo.
    pause
    exit /b 1
)

REM --- npm dependencies (Playwright) ---
if not exist "node_modules\playwright" (
    echo Installing npm dependencies ^(one-time, ~30 seconds^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

REM --- Playwright's bundled Chromium ---
REM Heuristic: if the standard Playwright cache dir doesn't exist, install
REM Chromium. Skips on subsequent runs.
if not exist "%LOCALAPPDATA%\ms-playwright" (
    echo Downloading Playwright Chromium ^(one-time, ~150 MB^)...
    call npx playwright install chromium
    if errorlevel 1 (
        echo.
        echo [ERROR] Playwright Chromium download failed.
        pause
        exit /b 1
    )
    echo.
)

REM --- First-time login hint ---
if not exist ".midasbuy-profile" (
    echo NOTE: No login profile found.
    echo /lookup will work, but /switch and /coupon need a logged-in session.
    echo To log in, close this and run once:
    echo     node midasbuy-hybrid.js init-login
    echo.
)

REM --- Run ---
echo Starting daemon...
echo Once you see "Listening on http://127.0.0.1:7777", open the Vercel UI.
echo Close this window or press Ctrl+C to stop.
echo.

node midasbuy-hybrid.js serve

echo.
echo Daemon stopped.
pause
endlocal
