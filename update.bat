@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Скачиваю main.py и gui.py ...
powershell -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/lolkiper/html/cursor/ldplayer-automation-17c8/main.py' -OutFile 'main.py' -UseBasicParsing"
powershell -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/lolkiper/html/cursor/ldplayer-automation-17c8/gui.py' -OutFile 'gui.py' -UseBasicParsing"
echo.
echo Готово. Проверка gui.py строка 117:
findstr /n "Тест ADB" gui.py
echo.
echo Запуск GUI...
python gui.py
pause
