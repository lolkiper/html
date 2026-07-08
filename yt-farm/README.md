# YouTube Zaliver v1.2

Панель для массового залива YouTube Shorts через **Dolphin Anty**.

## Режимы

| Тумблер | Режим | Что делает |
|---------|-------|------------|
| Фиолетовый — Обычный | `single` | **1 видео** за запуск, публикация **сразу** |
| Зелёный — Мульти | `multi` | **10 видео** за запуск + расписание `07:00 / 13:00 / 19:00 / 01:00` |

Переключатель сразу пишет настройки в `config.json`.

## Быстрый старт (Windows)

```bat
install.bat    ← один раз: npm + playwright + config.json
start.bat      ← запуск панели (режим разработки)
build.bat      ← сборка YouTube-Farm-Pro.exe
```

## Структура папки

```
yt-farm/
├── panel/                  ← Electron UI (ваш дизайн)
│   ├── index.html
│   ├── main.mjs
│   ├── preload.cjs
│   └── farm-orchestrator.mjs
├── main.mjs                ← скрипт фермы (10 видео в multi)
├── youtube-studio.mjs      ← автоматизация YouTube Studio
├── mode-presets.mjs        ← пресеты single / multi
├── config.example.json     ← шаблон конфига
├── config.json             ← ваш конфиг (создаётся при install)
├── videos/                 ← сюда кладёте part1.mov, part2.mov ...
├── channel-state.json      ← расписание каналов (создаётся автоматически)
├── install.bat
├── start.bat
└── build.bat
```

## Настройка config.json

1. `DOLPHIN_TOKEN` — токен из Dolphin Anty (Local API)
2. `VIDEOS_DIR` — путь к папке с видео (`part1.mov` … `part50.mov` на канал)
3. `PROFILE_MAPPING` — ID профиля Dolphin → номер канала
4. `BASE_TITLES` — названия (каждое с новой строки в UI)
5. `FARM_MODE`: `"single"` или `"multi"`

### Multi-режим (10 видео)

```json
{
  "FARM_MODE": "multi",
  "SCHEDULE_SETTINGS": {
    "BATCH_SIZE": 10,
    "VIDEOS_PER_CHANNEL": 50,
    "USE_SCHEDULE": true,
    "SCHEDULE_HOURS": [7, 13, 19, 1],
    "SCHEDULE_EXTENSION_BUFFER": 50
  },
  "ANTIDETECT": {
    "BETWEEN_UPLOAD_MIN_MS": 10000,
    "BETWEEN_UPLOAD_MAX_MS": 12000
  }
}
```

### Single-режим (1 видео сразу)

Переключите тумблер в UI на «Обычный режим» — пресет применится автоматически.

## Именование видео

Канал №1: `part1.mov` … `part50.mov`  
Канал №2: `part51.mov` … `part100.mov`  
Канал №N: `(N-1)*50 + 1` … `N*50`

## Сборка EXE

```bat
build.bat
```

Результат: `dist\YouTube-Farm-Pro.exe`

Рядом с EXE должны лежать (build.bat копирует автоматически):

- `main.mjs` (пресеты режимов встроены — отдельный `mode-presets.mjs` для воркера не нужен)
- `youtube-studio.mjs`
- `config.json`
- папка `videos\`

## Требования

- Windows 10/11
- Node.js 20+ LTS
- Dolphin Anty с включённым Local API (`http://localhost:3001`)
- Playwright Chromium (ставится через `install.bat`)

## Скачать с GitHub

Ветка: `cursor/zaliver-mode-switch-b855`

```
https://github.com/lolkiper/html/tree/cursor/zaliver-mode-switch-b855/yt-farm
```

Или ZIP:

```
https://github.com/lolkiper/html/archive/refs/heads/cursor/zaliver-mode-switch-b855.zip
```

Распакуйте папку `yt-farm` и запустите `install.bat`.
