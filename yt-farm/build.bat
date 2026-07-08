@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo Сначала запустите install.bat
  pause
  exit /b 1
)

echo.
echo ========================================
echo   Сборка YouTube-Farm-Pro.exe
echo ========================================
echo.

call npm run build:win
if errorlevel 1 goto :fail

echo.
echo ========================================
echo   Готово!
echo   EXE: dist\YouTube-Farm-Pro.exe
echo.
echo   Скопируйте рядом с EXE:
echo     - main.mjs
echo     - youtube-studio.mjs
echo     - mode-presets.mjs
echo     - config.json
echo     - папку videos\
echo ========================================
pause
exit /b 0

:fail
echo Сборка не удалась
pause
exit /b 1
