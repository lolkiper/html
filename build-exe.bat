@echo off
setlocal
title Shorts Inserter - build EXE
cd /d "%~dp0"

echo ==============================================
echo  Shorts Inserter 2.4.0 - Windows EXE build
echo ==============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo Node version: %%v
echo.

echo [1/3] Installing dependencies (this downloads Electron, ~150 MB)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your internet connection / proxy and retry.
  pause
  exit /b 1
)
echo.

echo [2/3] Fetching yt-dlp binary (optional, ignored on failure)...
call npm run ensure:ytdlp
echo.

echo [3/3] Building installer + portable EXE with electron-builder...
call npx electron-builder --win
if errorlevel 1 (
  echo [ERROR] Build failed. See the log above.
  pause
  exit /b 1
)

echo.
echo ==============================================
echo  DONE. Look in the "dist" folder:
echo    - "Shorts Inserter Setup 2.4.0.exe"  (installer)
echo    - "Shorts Inserter 2.4.0.exe"        (portable)
echo ==============================================
dir /b dist\*.exe 2>nul
echo.
pause
