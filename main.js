'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');

// Дискретный GPU вместо встроенного Intel — иначе NVENC часто не видит карту.
app.commandLine.appendSwitch('force_high_performance_gpu');

const {
  BatchProcessor,
  ENCODERS,
  EXPORT_MODES,
  RESOURCE_MODES,
  FRAME_PRESETS,
  FIT_MODES,
  DEFAULTS,
  VIDEO_EXTENSIONS,
  listVideoFiles,
  probeMedia,
  formatDuration,
  detectHardware,
  ffmpegPath,
  ffprobePath
} = require('./processor');

const {
  DownloadQueue,
  parseLinkList,
  resolveYtDlpPath,
  ytdlpExists,
  summarizeItems
} = require('./downloader');

const { analyzeRename, applyRename } = require('./renamer');
const {
  YoutubeClient,
  runOAuthLoopback,
  loadTokenFile,
  saveTokenFile
} = require('./youtube-api');
const { CopyrightChecker } = require('./copyright-check');

const VIDEO_FILTER = {
  name: 'Видео',
  extensions: VIDEO_EXTENSIONS.map((ext) => ext.replace('.', ''))
};

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {BatchProcessor|null} */
let activeBatch = null;
/** @type {DownloadQueue|null} */
let activeDownload = null;
/** @type {CopyrightChecker|null} */
let activeCopyright = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1040,
    minHeight: 740,
    show: false,
    backgroundColor: '#0e1117',
    autoHideMenuBar: true,
    title: 'Shorts Inserter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Внешние ссылки — в системном браузере, а не внутри приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function youtubeTokenPath() {
  return path.join(app.getPath('userData'), 'youtube-oauth.json');
}

function publicYoutubeChannel(stored) {
  if (!stored || !stored.channel) return null;
  return {
    id: stored.channel.id || '',
    title: stored.channel.title || '',
    customUrl: stored.channel.customUrl || ''
  };
}

function saveYoutubeTokens(tokens, extra = {}) {
  const previous = loadTokenFile(youtubeTokenPath()) || {};
  saveTokenFile(youtubeTokenPath(), {
    ...previous,
    ...tokens,
    ...extra,
    channel: extra.channel || previous.channel || null
  });
}

function createYoutubeClient(payload = {}) {
  const stored = loadTokenFile(youtubeTokenPath()) || {};
  const client = new YoutubeClient({
    clientId: payload.clientId || stored.clientId,
    clientSecret: payload.clientSecret,
    tokens: stored.refresh_token ? stored : null
  });
  client.onTokens = (tokens) => saveYoutubeTokens(tokens, { clientId: client.clientId });
  return client;
}

function copyrightHooks() {
  return {
    onLog: (level, message) => send('copyright:log', { level, message, time: Date.now() }),
    onProgress: (state) => send('copyright:progress', state),
    onState: (state) => send('copyright:state', state),
    onDone: (payload) => send('copyright:done', payload)
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => {
  const hardware = detectHardware();
  const gpuName = (hardware.h264 && hardware.h264.vendor) || (hardware.h265 && hardware.h265.vendor);
  return {
    version: app.getVersion(),
    encoders: Object.entries(ENCODERS).map(([value, preset]) => ({ value, label: preset.label })),
    exportModes: Object.entries(EXPORT_MODES).map(([value, mode]) => ({ value, label: mode.label })),
    resourceModes: Object.entries(RESOURCE_MODES).map(([value, mode]) => ({ value, label: mode.label })),
    frames: Object.entries(FRAME_PRESETS).map(([value, preset]) => ({ value, label: preset.label })),
    fits: Object.entries(FIT_MODES).map(([value, mode]) => ({ value, label: mode.label })),
    defaults: DEFAULTS,
    hardware: {
      gpu: gpuName || null,
      compiledGpu: hardware.compiledGpu || [],
      probeError: hardware.probeError || null,
      hwaccel: hardware.hwaccel,
      cores: hardware.cores
    },
    ffmpegPath,
    ffprobePath,
    ytdlpPath: resolveYtDlpPath(),
    ytdlpOk: ytdlpExists(resolveYtDlpPath()),
    copyrightConnected: Boolean((loadTokenFile(youtubeTokenPath()) || {}).refresh_token),
    copyrightChannel: publicYoutubeChannel(loadTokenFile(youtubeTokenPath()))
  };
});

ipcMain.handle('dialog:pick-directory', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Выберите папку',
    defaultPath: options.defaultPath && fs.existsSync(options.defaultPath) ? options.defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:pick-video', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Выберите видеофайл',
    defaultPath: options.defaultPath && fs.existsSync(options.defaultPath) ? options.defaultPath : undefined,
    properties: ['openFile'],
    filters: [VIDEO_FILTER, { name: 'Все файлы', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/** Сводка по папке с исходниками для подписи под полем ввода. */
ipcMain.handle('sources:scan', async (_event, payload = {}) => {
  const { directory, outputDir, outputPrefix } = payload;
  if (!directory || !fs.existsSync(directory)) return { count: 0, files: [], error: 'Папка не найдена' };
  try {
    const sameDir = outputDir && path.resolve(outputDir) === path.resolve(directory);
    const files = listVideoFiles(directory, { skipOutputNames: Boolean(sameDir), outputPrefix });
    return { count: files.length, files: files.map((file) => path.basename(file)) };
  } catch (err) {
    return { count: 0, files: [], error: err.message };
  }
});

/** Короткая информация о выбранном файле (для подписи в интерфейсе). */
ipcMain.handle('media:describe', async (_event, file) => {
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'Файл не найден' };
  try {
    const info = await probeMedia(file);
    return {
      ok: true,
      width: info.width,
      height: info.height,
      fps: info.fps,
      duration: info.duration,
      durationText: formatDuration(info.duration),
      hasAudio: info.hasAudio
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:open-path', async (_event, target) => {
  if (!target || !fs.existsSync(target)) return { ok: false, error: 'Путь не найден' };
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle('processing:start', async (_event, settings) => {
  if (activeBatch) {
    return { ok: false, error: 'Обработка уже запущена' };
  }

  const batch = new BatchProcessor(settings, {
    onLog: (level, message) => send('processing:log', { level, message, time: Date.now() }),
    onProgress: (state) => send('processing:progress', state)
  });

  activeBatch = batch;
  send('processing:state', { running: true });

  try {
    const summary = await batch.run();
    send('processing:done', { ok: true, summary });
    return { ok: true, summary };
  } catch (err) {
    send('processing:log', { level: 'error', message: err.message, time: Date.now() });
    send('processing:done', { ok: false, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    activeBatch = null;
    send('processing:state', { running: false });
  }
});

ipcMain.handle('processing:stop', () => {
  if (!activeBatch) return { ok: false, error: 'Обработка не запущена' };
  activeBatch.stop();
  return { ok: true };
});

ipcMain.handle('download:parse', (_event, text) => {
  const urls = parseLinkList(text);
  return { ok: true, urls, count: urls.length };
});

ipcMain.handle('download:import-txt', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Импортировать список ссылок',
    properties: ['openFile'],
    filters: [
      { name: 'Текст', extensions: ['txt', 'csv'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  try {
    const text = fs.readFileSync(result.filePaths[0], 'utf8');
    return { ok: true, text, file: result.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('download:load', (_event, outputDir) => {
  if (!outputDir || !fs.existsSync(outputDir)) {
    return { ok: false, error: 'Папка не найдена' };
  }
  const queue = new DownloadQueue({
    outputDir,
    ffmpegPath,
    ffprobePath,
    ytdlpPath: resolveYtDlpPath()
  });
  queue.items = queue.loadFromDisk();
  queue.reconcileExisting();
  const urls = queue.items.map((item) => item.url);
  const counts = summarizeItems(queue.items);
  return {
    ok: true,
    urls,
    note: counts.total
      ? `Найдена сохранённая очередь: готово ${counts.completed} из ${counts.total}.`
      : 'В папке появятся видео, nazvaniya.txt, download_queue.json и download_log.txt.',
    progress: {
      ...counts,
      overallPercent: counts.total ? (counts.completed / counts.total) * 100 : 0,
      current: null,
      items: queue.items,
      errors: queue.items.filter((item) => item.status === 'RETRY' || item.status === 'PERMANENT_ERROR'),
      status: counts.total ? `Очередь восстановлена: ${counts.completed} / ${counts.total}` : null
    }
  };
});

ipcMain.handle('download:start', async (_event, payload = {}) => {
  if (activeDownload && activeDownload.running) {
    return { ok: false, error: 'Скачивание уже запущено' };
  }
  const outputDir = payload.outputDir;
  const text = payload.text || '';
  if (!outputDir) return { ok: false, error: 'Не выбрана папка для сохранения.' };
  if (!ffmpegPath || (ffmpegPath !== 'ffmpeg' && !fs.existsSync(ffmpegPath))) {
    return { ok: false, error: 'FFmpeg не найден. Установите/укажите путь к FFmpeg.' };
  }
  const ytdlpPath = resolveYtDlpPath();
  if (!ytdlpExists(ytdlpPath)) {
    return { ok: false, error: 'yt-dlp не найден. Переустановите программу или положите yt-dlp в vendor/yt-dlp.' };
  }

  const queue = new DownloadQueue({
    outputDir,
    ffmpegPath,
    ffprobePath,
    ytdlpPath,
    hooks: {
      onLog: (level, message) => send('download:log', { level, message, time: Date.now() }),
      onProgress: (state) => send('download:progress', state)
    }
  });
  queue.setLinks(text);
  if (!queue.items.length) return { ok: false, error: 'В списке нет распознанных ссылок YouTube.' };

  activeDownload = queue;
  send('download:state', { running: true, paused: false });
  try {
    const summary = await queue.run();
    send('download:done', { ok: true, summary });
    return { ok: true, summary };
  } catch (err) {
    send('download:log', { level: 'error', message: err.message, time: Date.now() });
    send('download:done', { ok: false, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    activeDownload = null;
    send('download:state', { running: false, paused: false });
  }
});

ipcMain.handle('download:pause', () => {
  if (!activeDownload) return { ok: false, error: 'Скачивание не запущено' };
  activeDownload.pause();
  send('download:state', { running: true, paused: true });
  return { ok: true };
});

ipcMain.handle('download:resume', () => {
  if (!activeDownload) return { ok: false, error: 'Скачивание не запущено' };
  activeDownload.resume();
  send('download:state', { running: true, paused: false });
  return { ok: true };
});

ipcMain.handle('download:stop', () => {
  if (!activeDownload) return { ok: false, error: 'Скачивание не запущено' };
  activeDownload.stop();
  return { ok: true };
});

ipcMain.handle('rename:detect-txt', (_event, directory) => {
  if (!directory || !fs.existsSync(directory)) return { ok: false };
  const guessed = path.join(directory, 'nazvaniya.txt');
  if (fs.existsSync(guessed)) return { ok: true, file: guessed };
  return { ok: false };
});

ipcMain.handle('rename:pick-txt', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите nazvaniya.txt',
    defaultPath: options.defaultPath && fs.existsSync(options.defaultPath) ? options.defaultPath : undefined,
    properties: ['openFile'],
    filters: [
      { name: 'Текст', extensions: ['txt'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('rename:analyze', (_event, payload = {}) => {
  try {
    const analysis = analyzeRename({
      directory: payload.directory,
      titlesFile: payload.titlesFile,
      minScore: payload.minScore
    });
    return { ok: true, analysis };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rename:apply', (_event, payload = {}) => {
  try {
    const analysis = analyzeRename({
      directory: payload.directory,
      titlesFile: payload.titlesFile,
      minScore: payload.minScore
    });
    const result = applyRename(analysis, {
      removeUnmatchedVideos: payload.removeUnmatchedVideos,
      createReports: payload.createReports,
      keepOriginalTxt: payload.keepOriginalTxt
    });
    return { ok: true, analysis, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('copyright:status', async () => {
  const stored = loadTokenFile(youtubeTokenPath());
  return {
    ok: true,
    connected: Boolean(stored && stored.refresh_token),
    channel: publicYoutubeChannel(stored)
  };
});

ipcMain.handle('copyright:connect', async (_event, payload = {}) => {
  try {
    const tokens = await runOAuthLoopback({
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      onOpenUrl: (url) => shell.openExternal(url)
    });
    const packed = {
      ...tokens,
      clientId: payload.clientId,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000
    };
    saveYoutubeTokens(packed, { clientId: payload.clientId });
    const client = new YoutubeClient({
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      tokens: packed
    });
    client.onTokens = (next) => saveYoutubeTokens(next, { clientId: payload.clientId });
    const channel = await client.getChannel();
    saveYoutubeTokens(client.tokens, { clientId: payload.clientId, channel });
    return { ok: true, connected: true, channel };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('copyright:disconnect', () => {
  const file = youtubeTokenPath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, connected: false, channel: null };
});

ipcMain.handle('copyright:load', (_event, payload = {}) => {
  const directory = payload.directory;
  if (!directory || !fs.existsSync(directory)) {
    return { ok: false, error: 'Папка не найдена' };
  }
  const checker = new CopyrightChecker({ directory });
  checker.loadFromDisk();
  return { ok: true, snapshot: checker.snapshot() };
});

ipcMain.handle('copyright:start', async (_event, payload = {}) => {
  const directory = payload.directory;
  if (!directory) return { ok: false, error: 'Не выбрана папка с видео.' };
  const stored = loadTokenFile(youtubeTokenPath());
  if (!stored || !stored.refresh_token) {
    return { ok: false, error: 'Сначала подключите тестовый YouTube-канал.' };
  }
  if (!payload.clientId || !payload.clientSecret) {
    return { ok: false, error: 'Укажите OAuth Client ID и Client Secret.' };
  }
  if (activeCopyright && activeCopyright.running && path.resolve(activeCopyright.directory) !== path.resolve(directory)) {
    return { ok: false, error: 'Уже идёт проверка в другой папке.' };
  }

  const client = createYoutubeClient(payload);
  const maxWaitMs = Number(payload.maxWaitMinutes) > 0
    ? Number(payload.maxWaitMinutes) * 60 * 1000
    : undefined;

  if (activeCopyright && path.resolve(activeCopyright.directory) === path.resolve(directory) && activeCopyright.running) {
    if (payload.files && payload.files.length) activeCopyright.enqueueFiles(payload.files);
    else if (payload.enqueueDirectory) activeCopyright.enqueueDirectory();
    return { ok: true, running: true, snapshot: activeCopyright.snapshot() };
  }

  const checker = new CopyrightChecker({
    directory,
    client,
    maxWaitMs,
    autoDeleteUploads: Boolean(payload.autoDeleteUploads),
    hooks: copyrightHooks()
  });
  checker.loadFromDisk();
  if (payload.files && payload.files.length) checker.enqueueFiles(payload.files);
  else checker.enqueueDirectory();
  if (!checker.items.length) return { ok: false, error: 'В папке нет видео для проверки.' };

  activeCopyright = checker;
  send('copyright:state', { running: true });
  try {
    const snapshot = await checker.run();
    send('copyright:done', { ok: true, summary: snapshot.stats });
    return { ok: true, snapshot };
  } catch (err) {
    send('copyright:log', { level: 'error', message: err.message, time: Date.now() });
    send('copyright:done', { ok: false, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (activeCopyright === checker) activeCopyright = null;
    send('copyright:state', { running: false });
  }
});

ipcMain.handle('copyright:stop', () => {
  if (!activeCopyright) return { ok: false, error: 'Проверка не запущена' };
  activeCopyright.stop();
  return { ok: true };
});

ipcMain.handle('copyright:retry', async (_event, payload = {}) => {
  if (activeCopyright && activeCopyright.running) {
    if (payload.itemId) activeCopyright.retryOne(payload.itemId);
    else activeCopyright.retryFailed();
    return { ok: true, snapshot: activeCopyright.snapshot() };
  }
  const directory = payload.directory;
  if (!directory || !fs.existsSync(directory)) return { ok: false, error: 'Папка не найдена' };
  const checker = new CopyrightChecker({ directory });
  checker.loadFromDisk();
  if (payload.itemId) checker.retryOne(payload.itemId);
  else checker.retryFailed();
  return { ok: true, snapshot: checker.snapshot() };
});

// ---------------------------------------------------------------------------
// Жизненный цикл приложения
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (activeBatch) activeBatch.stop();
  if (activeDownload) activeDownload.stop();
  if (activeCopyright) activeCopyright.stop();
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(err);
  send('processing:log', {
    level: 'error',
    message: /ENAMETOOLONG/i.test(message)
      ? 'Команда FFmpeg слишком длинная для Windows. Каждый файл кодируется отдельно.'
      : `Сбой: ${message}`,
    time: Date.now()
  });
});

process.on('unhandledRejection', (err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(err);
  send('processing:log', { level: 'error', message: `Сбой: ${message}`, time: Date.now() });
});

app.on('before-quit', () => {
  if (activeBatch) activeBatch.stop();
  if (activeDownload) activeDownload.stop();
  if (activeCopyright) activeCopyright.stop();
});
