@echo off
chcp 65001 >nul
cd /d "%~dp0"
title YouTube Zaliver — диагностика

echo.
echo ========================================
echo   YouTube Zaliver — проверка окружения
echo ========================================
echo.
echo Папка: %CD%
echo.

set ERR=0

where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js не найден — нужен для ЗАПУСК.bat
  set ERR=1
) else (
  for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
)

if exist node_modules\electron (
  echo [OK] node_modules\electron
) else (
  echo [X] node_modules не установлены — запустите install.bat
  set ERR=1
)

if exist main.mjs (
  echo [OK] main.mjs
) else (
  echo [X] main.mjs отсутствует
  set ERR=1
)

if exist youtube-studio.mjs (
  echo [OK] youtube-studio.mjs
) else (
  echo [X] youtube-studio.mjs отсутствует
  set ERR=1
)

if exist panel\main.mjs (
  echo [OK] panel\main.mjs
) else (
  echo [X] panel\main.mjs отсутствует
  set ERR=1
)

if exist config.json (
  node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('[OK] config.json — синтаксис верный')" 2>nul
  if errorlevel 1 (
    echo [X] config.json — ошибка JSON! Удалите или исправьте файл
    set ERR=1
  )
) else (
  echo [!] config.json нет — создастся при первом запуске
)

if exist zaliver-error.log (
  echo.
  echo --- Последние ошибки zaliver-error.log ---
  powershell -NoProfile -Command "Get-Content -Path 'zaliver-error.log' -Tail 15"
)

echo.
if %ERR%==0 (
  echo Результат: всё в порядке, можно запускать ЗАПУСК.bat
) else (
  echo Результат: есть проблемы — исправьте пункты с [X]
)
echo.
pause
