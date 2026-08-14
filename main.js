'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');

// Дискретный GPU вместо встроенного Intel — иначе NVENC часто не видит карту.
app.commandLine.appendSwitch('force_high_performance_gpu');

const {
  BatchProcessor,
  ENCODERS,
  ACCEL_MODES,
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

const VIDEO_FILTER = {
  name: 'Видео',
  extensions: VIDEO_EXTENSIONS.map((ext) => ext.replace('.', ''))
};

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {BatchProcessor|null} */
let activeBatch = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 960,
    minHeight: 700,
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

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => {
  const hardware = detectHardware();
  const gpuName = (hardware.h264 && hardware.h264.vendor) || (hardware.h265 && hardware.h265.vendor);
  return {
    version: app.getVersion(),
    encoders: Object.entries(ENCODERS).map(([value, preset]) => ({ value, label: preset.label })),
    accels: Object.entries(ACCEL_MODES).map(([value, mode]) => ({ value, label: mode.label })),
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
    ffprobePath
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
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(err);
  send('processing:log', {
    level: 'error',
    message: /ENAMETOOLONG/i.test(message)
      ? 'Команда FFmpeg слишком длинная для Windows. Файлы будут кодироваться более короткими сессиями.'
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
});
