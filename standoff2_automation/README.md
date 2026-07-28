# Standoff 2 — ADB Automation Bot

Python-скрипт для циклической автоматизации Standoff 2 на Android-эмуляторе (LDPlayer / NOX / BlueStacks): логин через Google, привязка Twitch, парсинг цен с рынка (OCR) и выставление предметов из инвентаря. Управление через **ADB** — работает в фоне без эмуляции мыши.

## Структура

```
standoff2_automation/
├── main.py              # Точка входа, цикл по accounts.txt
├── config.py            # Пакет игры, задержки, координаты, шаблоны
├── adb_client.py        # ADB: tap, text, screencap, pm clear
├── vision.py            # OpenCV matchTemplate
├── ocr.py               # Tesseract — цифры цены
├── game_flow.py         # Логин, Twitch, инвентарь, logout
├── capture_template.py  # Утилита обрезки шаблонов
├── accounts.txt         # email:password (по одной строке)
├── requirements.txt
├── log.txt              # Создаётся при запуске
└── templates/           # PNG-шаблоны кнопок (см. templates/README.md)
```

## Требования

- Windows 10/11 x64
- Python 3.10+
- [Android Platform Tools (adb)](https://developer.android.com/tools/releases/platform-tools) в `PATH`
- [Tesseract OCR](https://github.com/UB-Mannheim/tesseract/wiki) — установить и добавить в `PATH`, либо задать `TESSDATA_PREFIX`
- Эмулятор с Standoff 2 и разрешением **1280×720**

## 1. Настройка эмулятора

### LDPlayer

1. Настройки → **Разрешение** → `1280 × 720`, DPI `240`.
2. Настройки → **Другие** → включить **ADB debugging**.
3. Порт ADB по умолчанию: `127.0.0.1:5555` (в настройках LDPlayer → ADB).

```bat
adb connect 127.0.0.1:5555
adb devices
```

### NOX

1. Настройки → разрешение `1280×720`.
2. Включить root/ADB в настройках NOX.
3. Порт обычно `127.0.0.1:62001`:

```bat
adb connect 127.0.0.1:62001
```

### BlueStacks 5

1. Настройки → Дисплей → `1280×720`.
2. Настройки → Расширенные → Android Debug Bridge → **Вкл**.
3. Порт смотреть в `ProgramData\BlueStacks_nxt\bluestacks.conf` (`adb_port`).

```bat
adb connect 127.0.0.1:<port>
```

Проверка:

```bat
adb -s 127.0.0.1:5555 shell wm size
:: Ожидается: Physical size: 1280x720
```

## 2. Установка Python-зависимостей

```bat
cd standoff2_automation
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Tesseract (если не в PATH):

```bat
set PATH=C:\Program Files\Tesseract-OCR;%PATH%
```

## 3. Шаблоны UI (обязательно)

Скрипт ищет кнопки по PNG-шаблонам в `templates/`. Без них автологин не сработает.

1. Запустите Standoff 2 в эмуляторе, дойдите до нужного экрана.
2. Скриншот:

```bat
adb -s 127.0.0.1:5555 exec-out screencap -p > screen.png
```

3. Обрежьте кнопку (координаты подберите в Paint / GIMP):

```bat
python capture_template.py screen.png google_sign_in 400 500 900 580
```

Полный список шаблонов — в `templates/README.md`.

## 4. Файл аккаунтов

`accounts.txt`:

```
user1@gmail.com:password1
user2@gmail.com:password2
```

Формат: `email:password`, по одной паре на строку. Строки с `#` игнорируются.

## 5. Запуск

Dry-run (проверка ADB + парсинг файла):

```bat
python main.py --serial 127.0.0.1:5555 --dry-run
```

Полный цикл:

```bat
python main.py --serial 127.0.0.1:5555 --accounts accounts.txt
```

Опции:

| Флаг | Описание |
|------|----------|
| `--serial` | ADB serial (по умолчанию `127.0.0.1:5555`) |
| `--accounts` | Путь к файлу аккаунтов |
| `--max-items` | Сколько слотов инвентаря обработать (default: 20) |
| `--dry-run` | Только проверка подключения |

Лог пишется в консоль и `log.txt`.

## 6. Демо на тестовых аккаунтах

1. Создайте 1–2 тестовых Google-аккаунта (или используйте свои).
2. Добавьте в `accounts.txt`.
3. Снимите шаблоны для экранов Google Login и главного меню.
4. Запустите:

```bat
python main.py --serial 127.0.0.1:5555 --max-items 3
```

Ожидаемый вывод:

```
2026-07-28 12:00:00 | INFO    | Loaded 2 account(s) from accounts.txt
2026-07-28 12:00:01 | INFO    | ADB connected: 127.0.0.1:5555
2026-07-28 12:00:01 | INFO    | Emulator resolution: 1280x720
2026-07-28 12:00:01 | INFO    | [1/2] Starting test1@gmail.com
...
2026-07-28 12:05:00 | INFO    | Parsed market price: 1250
2026-07-28 12:05:02 | INFO    | Listed item 0 at price 1250
...
2026-07-28 12:10:00 | INFO    | Done. Success: 2 | Failed/skipped: 0 | Total: 2
```

При ошибке (бан, кнопка не найдена) аккаунт **скипается**, цикл идёт дальше.

## 7. Тонкая настройка

- **Задержки** — `config.py` → класс `Delays` (эмулятор медленный → увеличить `launch_game`, `google_login`).
- **Координаты тапов** — `config.py` → `TapPoints` (сетка инвентаря, регион OCR цены).
- **Порог шаблона** — `TemplateConfig.match_threshold` (0.75–0.85).
- **Пакет игры** — `GAME_PACKAGE` / `GAME_ACTIVITY` в `config.py`.

## 8. Типичные проблемы

| Проблема | Решение |
|----------|---------|
| `device not found` | `adb connect <host:port>`, проверить ADB в эмуляторе |
| `Template not found` | Переснять шаблон при 1280×720, снизить/повысить threshold |
| OCR не читает цену | Расширить `market_price_region` в config, проверить Tesseract |
| Google не вводит пароль | Спецсимволы — проверить `_escape_adb_text` в adb_client.py |
| Скрипт не работает в фоне | Убедиться что используется ADB tap, а не клики мышью по окну |

## Примечание

Координаты и шаблоны зависят от версии Standoff 2 и скина UI эмулятора. После обновления игры переснимите `templates/`.
