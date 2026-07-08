@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ========================================
echo   YouTube Zaliver — установка зависимостей
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден. Установите LTS с https://nodejs.org
  pause
  exit /b 1
)

echo [1/4] npm install...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/4] Playwright Chromium...
call npx playwright install chromium
if errorlevel 1 goto :fail

echo.
echo [3/4] config.json...
if not exist config.json (
  copy /Y config.example.json config.json
  echo Создан config.json — откройте и вставьте DOLPHIN_TOKEN
) else (
  echo config.json уже есть, пропускаю
)

echo.
echo [4/4] Папка videos...
if not exist videos mkdir videos

echo.
echo ========================================
echo   Готово! Запуск: start.bat
echo   Сборка EXE: build.bat
echo ========================================
pause
exit /b 0

:fail
echo.
echo [ОШИБКА] Установка не завершена
pause
exit /b 1
