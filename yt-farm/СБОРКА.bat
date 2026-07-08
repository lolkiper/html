@echo off
chcp 65001 >nul
cd /d "%~dp0"
title YouTube Zaliver — полная установка и сборка

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   YOUTUBE ZALIVER v1.2 — ПОЛНАЯ СБОРКА   ║
echo  ╚══════════════════════════════════════════╝
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ОШИБКА] Установите Node.js LTS: https://nodejs.org
  pause
  exit /b 1
)

echo [1/5] npm install...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/5] Playwright Chromium...
call npx playwright install chromium
if errorlevel 1 goto :fail

echo.
echo [3/5] config.json...
if not exist config.json copy /Y config.example.json config.json

echo.
echo [4/5] Папка videos...
if not exist videos mkdir videos

echo.
echo [5/5] Сборка EXE...
call npm run build:win
if errorlevel 1 goto :fail

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║              ГОТОВО!                      ║
echo  ╠══════════════════════════════════════════╣
echo  ║  Запуск EXE:                              ║
echo  ║  dist\win-unpacked\YouTube Zaliver.exe     ║
echo  ║                                           ║
echo  ║  Или без EXE (для теста):                 ║
echo  ║  start.bat                                ║
echo  ╚══════════════════════════════════════════╝
pause
exit /b 0

:fail
echo.
echo [ОШИБКА] Сборка прервана
pause
exit /b 1
