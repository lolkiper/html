@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

set "TARGET=dist\win-unpacked"
if not exist "%TARGET%" (
  echo [copy-farm] %TARGET% не найдена
  exit /b 0
)

echo [copy-farm] Копирую скрипты в %TARGET%...
copy /Y main.mjs "%TARGET%\" >nul
copy /Y youtube-studio.mjs "%TARGET%\" >nul
if not exist "%TARGET%\videos" mkdir "%TARGET%\videos"
if not exist "%TARGET%\config.json" if exist config.example.json copy /Y config.example.json "%TARGET%\config.json" >nul
echo [copy-farm] OK: main.mjs + youtube-studio.mjs
exit /b 0
