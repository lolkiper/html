# YouTube Dolphin Bot

Автоматизирует вход в аккаунты YouTube через браузерные профили **Dolphin Anty** и меняет язык интерфейса на английский.

---

## Что делает бот

1. Читает аккаунты из текстового файла (`email`, `пароль`, `TOTP-секрет`, опционально прокси).
2. Создаёт отдельный браузерный профиль в Dolphin Anty для каждого аккаунта.
3. Загружает прокси в этот профиль.
4. Открывает YouTube, выполняет вход (в том числе с 2FA).
5. Меняет язык интерфейса YouTube на **English (US)**.
6. Закрывает профиль (и при необходимости удаляет его).
7. Сохраняет результаты в CSV-файл.

---

## Требования

| Компонент | Версия |
|-----------|--------|
| Python    | ≥ 3.10 |
| Dolphin Anty (Desktop) | любая |
| Google Chrome / Chromium | устанавливается Dolphin |

### Установка зависимостей

```bash
pip install -r requirements.txt
```

---

## Настройка Dolphin Anty

1. Откройте Dolphin Anty.
2. Перейдите в **Settings → Automation**.
3. Включите **Local API** — должен запуститься сервер на `http://localhost:3001`.
4. (опционально) Скопируйте API-токен если он требуется.

---

## Формат файлов

### `accounts.txt`

Каждая строка — один аккаунт. Разделитель `:` (или `|`).

```
email:пароль:TOTP_секрет
email:пароль:TOTP_секрет:proxy_строка
email:пароль:              ← без 2FA
```

**Откуда взять TOTP-секрет?**

Это Base32-строка (буквы A–Z и цифры 2–7), которую показывает Google при включении двухфакторной аутентификации. Её же используют Google Authenticator, Authy и т.д.

Пример секрета: `JBSWY3DPEHPK3PXP`

Если у вас есть только QR-код, его URL выглядит так:
```
otpauth://totp/Google%3Ayou@gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google
```
Значение после `secret=` — это и есть секрет.

> Бот генерирует 6-значный код **локально** с помощью библиотеки `pyotp` — сторонние сайты не нужны.

### `proxies.txt`

```
socks5://user:pass@host:port
http://host:port
host:port:user:pass
host:port
```

Прокси раздаются по кругу (round-robin) между аккаунтами, у которых нет своего прокси.

---

## Запуск

```bash
# Базовый запуск
python main.py --accounts accounts.txt

# С файлом прокси
python main.py --accounts accounts.txt --proxies proxies.txt

# Обработать только аккаунты с 5 по 10
python main.py --accounts accounts.txt --proxies proxies.txt --start 5 --end 10

# Не удалять профили после обработки
python main.py --accounts accounts.txt --keep-profiles

# Задержка 10 секунд между аккаунтами
python main.py --accounts accounts.txt --delay 10

# Все опции
python main.py --help
```

---

## Все параметры

| Параметр | По умолчанию | Описание |
|----------|-------------|----------|
| `--accounts` | *обязательный* | Путь к файлу аккаунтов |
| `--proxies` | нет | Путь к файлу прокси |
| `--dolphin-api` | `http://localhost:3001/v1.0` | URL локального API Dolphin |
| `--dolphin-token` | нет | API-токен Dolphin (если нужен) |
| `--delay` | `5` | Пауза между аккаунтами (секунды) |
| `--keep-profiles` | нет | Не удалять профили Dolphin |
| `--headless` | нет | Запускать браузер без UI |
| `--start` | `1` | Первый аккаунт для обработки (1-based) |
| `--end` | `0` (все) | Последний аккаунт для обработки |
| `--results` | `results.csv` | Файл для сохранения результатов |
| `--log` | `bot.log` | Файл логов |
| `--verbose` / `-v` | нет | Подробное логирование |

---

## Результаты

После завершения создаётся файл `results.csv`:

```
email,status,profile_id,note
example1@gmail.com,success,12345,
example2@gmail.com,failed,,Login failed
```

---

## Частые проблемы

| Проблема | Решение |
|----------|---------|
| `Cannot reach Dolphin Anty API` | Убедитесь что Dolphin открыт и Local API включён |
| `Login failed` | Проверьте email/пароль; возможно аккаунт заблокирован Google |
| `2FA required but no TOTP secret` | Добавьте TOTP-секрет в строку аккаунта |
| `Could not find Language option` | Обновите Selenium (`pip install -U selenium`) |
| Selenium не подключается | Проверьте что в `start_profile` вернулся `port` |

---

## Структура проекта

```
youtube_dolphin_bot/
├── main.py               # точка входа, CLI
├── dolphin_api.py        # клиент Dolphin Anty Local API
├── youtube_automation.py # Selenium: вход + смена языка
├── totp_helper.py        # генератор TOTP-кодов (pyotp)
├── account_parser.py     # разбор accounts.txt и proxies.txt
├── config.py             # настройки
├── requirements.txt      # зависимости Python
├── accounts_example.txt  # пример файла аккаунтов
└── proxies_example.txt   # пример файла прокси
```
