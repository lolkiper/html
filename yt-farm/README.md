# YouTube Zaliver v1.2

## Скачать полную папку

| Способ | Ссылка |
|--------|--------|
| **ZIP (всё сразу)** | https://github.com/lolkiper/html/archive/refs/heads/cursor/zaliver-mode-switch-b855.zip |
| Папка на GitHub | https://github.com/lolkiper/html/tree/cursor/zaliver-mode-switch-b855/yt-farm |

После распаковки ZIP зайди в папку **`yt-farm`**.

---

## Запуск за 2 клика

```
1. install.bat     ← один раз
2. ЗАПУСК.bat     ← каждый раз
```

Или открой **`НАЧНИ-ЗДЕСЬ.txt`** — там та же инструкция.

---

## Полная структура папки

```
yt-farm/
│
├── ЗАПУСК.bat              ★ главный запуск
├── НАЧНИ-ЗДЕСЬ.txt         ★ инструкция
├── install.bat             установка (1 раз)
├── start.bat               запуск (если уже установлено)
├── СБОРКА.bat              сборка EXE
├── build.bat               только сборка (без install)
│
├── panel/                  интерфейс программы
│   ├── index.html          дизайн Zaliver v1.2
│   ├── main.mjs            Electron
│   ├── preload.cjs
│   ├── farm-orchestrator.mjs
│   ├── mode-presets.mjs    пресеты single/multi
│   └── ensure-farm-scripts.mjs
│
├── main.mjs                скрипт фермы (10 видео)
├── youtube-studio.mjs      автоматизация YouTube Studio
├── config.example.json     шаблон настроек
├── config.json             твои настройки (создаётся при install)
│
├── videos/                 сюда видео part1.mov, part2.mov ...
├── titles.example.txt      пример названий
│
├── scripts/
│   ├── kill-and-clean.bat
│   └── copy-farm-to-dist.bat
│
├── package.json
├── electron-builder.json
└── README.md
```

---

## Настройка

1. `install.bat`
2. Открой `config.json` → `DOLPHIN_TOKEN`
3. `ЗАПУСК.bat`
4. В программе: путь к видео, профили Dolphin, названия
5. Видео в `videos\`

---

## Режимы

| Тумблер | Режим |
|---------|-------|
| Фиолетовый | 1 видео, сразу |
| Зелёный | 10 видео + расписание |

---

## Сборка EXE

Закрой программу → `СБОРКА.bat` → `dist\win-unpacked\YouTube Zaliver.exe`

---

## Требования

- Windows 10/11
- Node.js 20+ LTS
- Dolphin Anty (Local API включён)
