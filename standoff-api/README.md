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

## Логи (формат как в фарме)

```
[twitch] cycle 1 start: 40 accounts, no repeat
[standoff] 1/40 google=user@gmail.com | twitch=twitch_user | starting...
[twitch] 1/40 bind twitch_user... ok
[market] 1/40 sold=3 items, gross=45.00G
[standoff] 1/40 google=user@gmail.com | done ok | linked | sold=3 | gross=45.00G net≈33.75G | time=62.3s
[twitch] cycle 1 complete: processed 40/40, ok=20, errors=20, sent=4571.60G, net≈3428.69G, time=420.6s, no repeat
```

Пишется в консоль и в `cycle_log.txt`.

### CLI цикл

```bash
python run_cycle.py --limit 40
```

### API цикл

```bash
POST /cycles/run
{"limit": 40, "cycle_no": 1, "repeat": false}
```

`net` = `sent * MARKET_FEE_RATE` (по умолчанию 0.75 — комиссия рынка).

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
