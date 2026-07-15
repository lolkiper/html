# Standoff 2 — OpenCV Bot (LDPlayer + ADB)

Автоматизация: **Google вход → Standoff 2 → продажа кейсов по цене запроса → логаут** для списка аккаунтов.

## Стек

- Python 3.11+
- ADB (`subprocess` → `adb.exe` из LDPlayer)
- **OpenCV** — поиск кнопок по шаблонам PNG
- **Pillow** — скриншоты
- **pytesseract** — OCR цены запроса на рынке
- **uiautomator fallback** — Google Auth, если шаблонов нет

## Быстрый старт (Windows + LDPlayer 9)

```cmd
cd standoff-api
pip install -r requirements.txt
pip install -r requirements-opencv.txt

copy opencv_bot\config.example.json opencv_bot\config.json
copy opencv_bot\accounts.example.txt opencv_bot\accounts.txt
```

Отредактируй `opencv_bot\config.json` — `LDPLAYER_HOME`, `EMULATOR_INDEX`, координаты под 1280×720.

В `opencv_bot\accounts.txt`:
```
email@gmail.com:google_password
```

Запуск:
```cmd
python -m opencv_bot.run_bot
python -m opencv_bot.run_bot --limit 1
```

## Файлы результатов

| Файл | Назначение |
|------|------------|
| `opencv_bot/accounts.txt` | Очередь аккаунтов `email:pass` |
| `opencv_bot/done.txt` | Успешно обработанные |
| `opencv_bot/error.txt` | Ошибки (+ скрин в `screenshots/`) |

## Алгоритм

1. Подключение ADB к LDPlayer
2. `pm clear` Standoff 2 + Google Play Services
3. Запуск игры → Google Auth (OpenCV + UI dump)
4. Лобби → инвентарь → рынок
5. Для каждого кейса: OCR цены запроса → выставить → подтвердить
6. Логаут → следующий аккаунт

## Шаблоны OpenCV

См. `opencv_bot/templates/README.md` — вырежь PNG с кнопок. Без шаблонов используются координаты из `COORDS`.

## Tesseract (OCR)

Скачай Tesseract для Windows и пропиши путь в `config.json` → `OCR.tesseract_cmd`.

## Связь с standoff-api

| Модуль | Назначение |
|--------|------------|
| `opencv_bot/` | Полный цикл через OpenCV (этот бот) |
| `run_prepare.py` | Только handshake через эмулятор |
| `run_farm.py` | API-фарм по готовым handshake |

Скачать ветку: https://github.com/lolkiper/html/archive/refs/heads/cursor/standoff-api-b855.zip
