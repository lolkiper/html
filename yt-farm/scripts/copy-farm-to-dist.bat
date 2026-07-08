@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

set "TARGET=dist\win-unpacked"
if not exist "%TARGET%" (
  echo [copy-farm] Папка %TARGET% не найдена — пропускаю
  exit /b 0
)

echo [copy-farm] Копирую скрипты фермы в %TARGET%...
copy /Y main.mjs "%TARGET%\" >nul
copy /Y youtube-studio.mjs "%TARGET%\" >nul
copy /Y mode-presets.mjs "%TARGET%\" >nul
if not exist "%TARGET%\videos" mkdir "%TARGET%\videos"
if not exist "%TARGET%\config.json" if exist config.example.json copy /Y config.example.json "%TARGET%\config.json" >nul
echo [copy-farm] Готово: main.mjs, youtube-studio.mjs, mode-presets.mjs
exit /b 0
