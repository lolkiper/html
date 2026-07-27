@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo Зависимости не установлены. Запустите install.bat
  pause
  exit /b 1
)

if not exist config.json (
  copy /Y config.example.json config.json
  echo Создан config.json — настройте DOLPHIN_TOKEN и каналы
)

echo Запуск YouTube Zaliver v1.2...
call npm run panel
