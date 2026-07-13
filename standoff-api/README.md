# Standoff 2 API

HTTP API: **Google вход → Standoff 2 → привязка Twitch → продажа кейсов** на LDPlayer (Windows).

## Требования

- Windows
- [LDPlayer 9](https://www.ldplayer.net/) + ADB включён
- Python 3.11+

## Установка

```bash
cd standoff-api
pip install -r requirements.txt
copy config.example.json config.json
copy accounts.example.txt accounts.txt
```

В `config.json` укажи `LDPLAYER_HOME` и `API_KEY`.

Формат `accounts.txt` (одна строка — один аккаунт):

```
google@gmail.com:google_pass:twitch_login:twitch_pass
```

## Запуск API

```bash
python run.py
```

Документация: http://localhost:8080/docs

## Эндпоинты

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/health` | Статус, найден ли LDPlayer |
| POST | `/jobs` | Одна задача (JSON) |
| POST | `/jobs/batch` | Все аккаунты из `accounts.txt` |
| GET | `/jobs` | Список задач |
| GET | `/jobs/{id}` | Статус задачи |
| GET | `/jobs/{id}/logs` | Лог выполнения |

Заголовок (если задан `API_KEY`): `X-API-Key: твой_ключ`

## Пример запроса

```bash
curl -X POST http://localhost:8080/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: твой_ключ" \
  -d '{
    "account": {
      "google_login": "g@gmail.com",
      "google_password": "gpass",
      "twitch_login": "twitch_user",
      "twitch_password": "tpass"
    },
    "options": {
      "link_twitch": true,
      "sell_cases": true,
      "sell_min_price": true,
      "sell_max_items": 50
    }
  }'
```

Ответ:

```json
{
  "id": "a1b2c3d4e5f6",
  "status": "queued",
  "created_at": "..."
}
```

Проверка:

```bash
curl http://localhost:8080/jobs/a1b2c3d4e5f6 -H "X-API-Key: твой_ключ"
```

## Пайплайн

1. Сброс IMEI/Android ID в LDPlayer
2. Добавление Google-аккаунта (Android Settings)
3. Запуск Standoff 2 + вход через Google
4. Настройки → Игра → Привязать Twitch
5. Инвентарь → Рынок → продажа кейсов по мин. цене
6. Очистка аккаунта с эмулятора

Координаты UI рассчитаны на **1280×720**. При другом разрешении подстрой в `app/steps/`.

## Важно

- Официального API у Standoff 2 нет — автоматизация через ADB/UI
- Использование ботов может нарушать ToS игры
- Один воркер за раз (один эмулятор)
