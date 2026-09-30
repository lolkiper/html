# twitch_dolphin

Автоматизация работы с Twitch через профили [Dolphin Anty](https://dolphin-anty.com/): авторизация аккаунтов, поиск канала и просмотр стрима с сохранением прогресса.

## Структура проекта

```text
twitch_dolphin/
├── main.py
├── config.json
├── profiles.txt
├── accounts.txt          # локально, не коммитить
├── accounts.txt.example
├── progress.json
├── requirements.txt
├── README.md
├── modules/
│   ├── dolphin.py
│   ├── twitch.py
│   ├── auth.py
│   ├── logger.py
│   └── utils.py
└── logs/
    └── app.log
```

## Установка

```bash
cd twitch_dolphin
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Убедитесь, что запущен **Dolphin Anty** с включённым локальным API (по умолчанию `http://localhost:3001`).

## profiles.txt

Один ID профиля Dolphin на строку. Пустые строки и строки, начинающиеся с `#`, игнорируются.

## accounts.txt (чувствительные данные)

Формат каждой строки:

```text
PROFILE_ID|LOGIN|PASSWORD
PROFILE_ID_2|LOGIN_2|PASSWORD_2
```

- **PROFILE_ID** — ID профиля в Dolphin Anty (тот же, что в `profiles.txt`).
- **LOGIN** — логин Twitch.
- **PASSWORD** — пароль Twitch.

Пример:

```text
123456789|my_twitch_user|my_secret_password
```

### Важно по безопасности

- Файл **`accounts.txt` содержит пароли**. Не публикуйте его в GitHub, не отправляйте в чаты и не выкладывайте в облако без шифрования.
- Файл добавлен в `.gitignore`. Для примера используйте `accounts.txt.example`.
- Скрипт **не выводит пароли** в консоль и не пишет их в `logs/app.log` или `progress.json`.
- Содержимое `accounts.txt` **не отправляется** на сторонние серверы — только локальный вход на twitch.tv через ваш браузер Dolphin.

Скопируйте пример и заполните своими данными:

```bash
cp accounts.txt.example accounts.txt
```

## config.json

Основные параметры: URL API Dolphin, таймауты, запрос поиска (`search_query`, по умолчанию `Jumble`), длительность просмотра в секундах.

## progress.json

Для каждого профиля сохраняется статус без паролей:

```json
{
    "123456789": {
        "login": "success",
        "jumble": "found",
        "completed": true
    }
}
```

Возможные значения `login`: `success`, `manual_verification_required`, `failed`, `credentials_missing`, `empty_password`, `not_started`.

## Запуск

```bash
python main.py
```

## Порядок работы одного профиля

1. Чтение Profile ID  
2. Поиск учётных данных в `accounts.txt`  
3. Запуск профиля Dolphin  
4. Подключение WebDriver (CDP/debugger)  
5. Открытие Twitch  
6. Проверка существующей сессии (cookies профиля)  
7. Если уже авторизован — продолжение без повторного входа (`Login already active`)  
8. Иначе — ввод логина и пароля, Log In  
9. Проверка успешной авторизации  
10. При CAPTCHA / 2FA / email / телефон / блокировке — **без обхода**, лог `Manual verification required`, переход к следующему профилю  
11. Поиск «Jumble», просмотр, запись в лог и `progress.json`  
12. Закрытие WebDriver и остановка профиля Dolphin  

## Модуль auth.py

- `check_logged_in(driver)` — есть ли активная сессия Twitch  
- `login_twitch(driver, username, password, ...)` — вход с проверкой существующей сессии  
- `verify_login(driver)` — подтверждение успешного входа или необходимости ручной проверки  

## Логи

Сообщения в консоли и в `logs/app.log`, например:

```text
INFO | Profile 123456 | Twitch login successful
WARNING | Profile 123456 | Manual verification required
ERROR | Profile 123456 | Account credentials not found
```

Пароль в логах не отображается.
