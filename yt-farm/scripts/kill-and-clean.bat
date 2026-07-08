@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [clean] Закрываю YouTube Zaliver / Electron...
taskkill /F /IM "YouTube Zaliver.exe" 2>nul
taskkill /F /IM "YouTube-Farm-Pro.exe" 2>nul
taskkill /F /IM electron.exe 2>nul
timeout /t 2 /nobreak >nul

echo [clean] Удаляю папку dist...
if exist dist (
  attrib -R /S /D dist\*.* 2>nul
  rmdir /S /Q dist 2>nul
)

if exist dist (
  echo.
  echo [ВНИМАНИЕ] Папка dist заблокирована!
  echo   1. Закрой YouTube Zaliver и все окна Electron
  echo   2. Закрой Проводник если открыта папка dist
  echo   3. Нажми любую клавишу для повторной попытки...
  pause >nul
  taskkill /F /IM electron.exe 2>nul
  timeout /t 2 /nobreak >nul
  rmdir /S /Q dist 2>nul
)

if exist dist (
  echo [ОШИБКА] Не могу удалить dist. Перезагрузи ПК или удали dist вручную.
  exit /b 1
)

echo [clean] OK
exit /b 0
