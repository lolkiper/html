@echo off
chcp 65001 >nul
cd /d "%~dp0"
title YouTube Zaliver v1.2

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ОШИБКА] Node.js не установлен!
  echo Скачай: https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo Первый запуск — устанавливаю зависимости...
  echo.
  call install.bat
  if errorlevel 1 exit /b 1
)

if not exist config.json (
  copy /Y config.example.json config.json
  echo.
  echo Создан config.json — вставь DOLPHIN_TOKEN и перезапусти ЗАПУСК.bat
  echo.
  pause
  exit /b 0
)

if not exist videos mkdir videos

echo.
echo Запуск YouTube Zaliver...
call npm run panel
