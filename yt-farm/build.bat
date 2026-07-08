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
echo   Сборка YouTube Zaliver
echo ========================================
echo.

call scripts\kill-and-clean.bat
if errorlevel 1 (
  echo.
  echo Закрой программу и папку dist, потом повтори
  pause
  exit /b 1
)

set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --config electron-builder.json --win dir
if errorlevel 1 goto :fail

call scripts\copy-farm-to-dist.bat

echo.
echo ========================================
echo   Готово!
echo   Запуск: dist\win-unpacked\YouTube Zaliver.exe
echo ========================================
pause
exit /b 0

:fail
echo.
echo Сборка не удалась.
echo.
echo Если Access denied — закрой EXE и Electron.
echo Если app-builder.exe — добавь папку в исключения антивируса.
echo.
echo Без EXE можно запустить: start.bat
pause
exit /b 1
