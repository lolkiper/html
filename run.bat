@echo off
rem Starts the LDPlayer Visual UI Tester, preparing the environment on first run.
rem Any argument is passed through to main.py, e.g.  run.bat --list-instances
setlocal
cd /d "%~dp0"

set "PYTHON="
py -3 --version >nul 2>&1 && set "PYTHON=py -3"
if not defined PYTHON (
    python --version >nul 2>&1 && set "PYTHON=python"
)
if not defined PYTHON goto :no_python

%PYTHON% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if errorlevel 1 goto :old_python

if not exist ".venv\Scripts\python.exe" (
    echo Creating the virtual environment .venv ...
    %PYTHON% -m venv .venv || goto :venv_failed
)

set "VENV_PYTHON=.venv\Scripts\python.exe"

if not exist ".venv\.dependencies-installed" (
    echo Installing dependencies, this takes a minute ...
    "%VENV_PYTHON%" -m pip install --upgrade pip
    "%VENV_PYTHON%" -m pip install -r requirements.txt || goto :install_failed
    echo ok > ".venv\.dependencies-installed"
    echo.
    echo Dependencies installed. OCR is optional: for the text and number
    echo conditions run  .venv\Scripts\pip install -r requirements-ocr.txt
    echo.
)

"%VENV_PYTHON%" main.py %*
if errorlevel 1 goto :run_failed
exit /b 0

:no_python
echo.
echo Python 3.11 or newer was not found.
echo Install it from https://www.python.org/downloads/windows/ and tick
echo "Add python.exe to PATH" in the installer, then run this file again.
echo.
pause
exit /b 1

:old_python
echo.
echo This application needs Python 3.11 or newer. Found:
%PYTHON% --version
echo Install a newer version from https://www.python.org/downloads/windows/
echo.
pause
exit /b 1

:venv_failed
echo.
echo The virtual environment could not be created. Make sure the folder is
echo writable and not inside a synchronised cloud directory.
echo.
pause
exit /b 1

:install_failed
echo.
echo Installing the dependencies failed. Check the network connection and the
echo messages above, then run this file again.
echo.
pause
exit /b 1

:run_failed
echo.
echo The application exited with an error, see the messages above.
echo.
pause
exit /b 1
