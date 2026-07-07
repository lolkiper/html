@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo YT Stats Bot
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo Python not found. Install Python 3.10+ from https://www.python.org/downloads/
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo Failed to create venv
        pause
        exit /b 1
    )
)

call .venv\Scripts\activate.bat

if not exist ".deps_installed" (
    echo Installing dependencies...
    python -m pip install --upgrade pip
    pip install -r requirements.txt
    if errorlevel 1 (
        echo Failed to install dependencies
        pause
        exit /b 1
    )
    echo. > .deps_installed
)

if not exist "channels.txt" (
    copy /Y channels.example.txt channels.txt >nul
    echo Created channels.txt - add your channel links
)

python app.py
pause
