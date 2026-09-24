# Сборка EXE — Shorts Inserter 1.9.0

## Быстрый путь (Windows)

1. Установите [Node.js 18+](https://nodejs.org) (LTS).
2. Распакуйте архив в папку без кириллицы и пробелов, например `C:\build\shorts-inserter`.
3. Двойным щелчком запустите **`build-exe.bat`**.
4. Через 5–15 минут в папке `dist` появятся:
   - `Shorts Inserter Setup 1.9.0.exe` — установщик (NSIS, с выбором папки установки и ярлыком на рабочем столе);
   - `Shorts Inserter 1.9.0.exe` — портативная версия (запуск без установки).

## Вручную (та же последовательность)

```bat
npm install
npm run ensure:ytdlp
npx electron-builder --win
```

Только портативный exe без установщика:

```bat
npm run dist:portable
```

Быстрая распакованная сборка для проверки (без упаковки в exe):

```bat
npm run pack
```

Запуск в режиме разработки:

```bat
npm start
```

## Требования

- Node.js 18+ и npm;
- **интернет обязателен на этапе `npm install`** — скачиваются Electron 31 (~150 МБ), ffmpeg-static, ffprobe-static и NSIS-ресурсы electron-builder;
- ~2 ГБ свободного места на диске;
- Windows 10/11 x64 (сборка настроена на `arch: x64`).

## Возможные проблемы

| Симптом | Решение |
|---|---|
| `ENOTFOUND registry.npmjs.org` | нет доступа в сеть/прокси. Задайте прокси: `npm config set proxy http://host:port` и `npm config set https-proxy http://host:port` |
| Долгая загрузка Electron или ошибка 403 | используйте зеркало: `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` перед `npm install` |
| `cannot execute winCodeSign` / ошибки подписи | подпись не настроена и не нужна; при ошибке добавьте `set CSC_IDENTITY_AUTO_DISCOVERY=false` |
| Антивирус блокирует сборку | добавьте папку проекта и `%LOCALAPPDATA%\electron-builder` в исключения |
| Папка `vendor/yt-dlp` пустая | скачивание yt-dlp не критично для сборки; можно положить `yt-dlp.exe` в `vendor/yt-dlp` вручную |

## Кросс-сборка с Linux/macOS

Возможна через Docker-образ electron-builder:

```bash
docker run --rm -ti -v ${PWD}:/project electronuserland/builder:wine \
  /bin/bash -c "npm install && npx electron-builder --win"
```

Без сети и без Wine собрать Windows-исполняемый файл нельзя.
