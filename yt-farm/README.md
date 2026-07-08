# YouTube Zaliver v1.2 — готовая папка

## Скачать всю папку

ZIP: https://github.com/lolkiper/html/archive/refs/heads/cursor/zaliver-mode-switch-b855.zip

Распакуй → зайди в `yt-farm`

---

## Вариант А — запуск без EXE (самый простой)

```bat
install.bat
start.bat
```

Откроется панель с тумблером режимов. Работает сразу после `install.bat`.

---

## Вариант Б — собрать EXE

**Перед сборкой закрой программу**, если она запущена.

```bat
СБОРКА.bat
```

Готовый файл: `dist\win-unpacked\YouTube Zaliver.exe`

Если ошибка **Access denied** — закрой EXE и папку `dist` в Проводнике, запусти снова.

Если **app-builder.exe** — добавь папку `yt-farm` в исключения антивируса (Windows Defender).

---

## Настройка

1. Открой `config.json`
2. Вставь `DOLPHIN_TOKEN` из Dolphin Anty
3. Укажи профили в UI или в `PROFILE_MAPPING`
4. Положи видео в `videos\` (`part1.mov`, `part2.mov` …)

---

## Режимы (тумблер в программе)

| Режим | Действие |
|-------|----------|
| Фиолетовый | 1 видео, публикация сразу |
| Зелёный | 10 видео + расписание 07/13/19/01 |

---

## Структура папки

```
yt-farm/
├── panel/              ← программа (UI)
│   ├── index.html
│   ├── main.mjs
│   ├── mode-presets.mjs   (внутри panel, не отдельно!)
│   └── ...
├── main.mjs            ← скрипт залива 10 видео
├── youtube-studio.mjs  ← автоматизация YouTube
├── config.json
├── videos/
├── install.bat         ← установка
├── start.bat           ← запуск
└── СБОРКА.bat          ← сборка EXE
```

**Важно:** файл `mode-presets.mjs` теперь только внутри `panel\`. Отдельный файл в корне не нужен.

---

## Если была ошибка mode-presets.mjs

1. Удали старую папку целиком
2. Скачай ZIP заново
3. Запусти `install.bat` → `start.bat`

Или пересобери: `СБОРКА.bat`
