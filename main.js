'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, Menu } = require('electron');

// Дискретный GPU вместо встроенного Intel — иначе NVENC часто не видит карту.
app.commandLine.appendSwitch('force_high_performance_gpu');

const {
  BatchProcessor,
  ENCODERS,
  EXPORT_MODES,
  RESOURCE_MODES,
  PARALLEL_MODES,
  FRAME_PRESETS,
  FIT_MODES,
  DEFAULTS,
  VIDEO_EXTENSIONS,
  listVideoFiles,
  probeMedia,
  formatDuration,
  detectHardwareAsync,
  ffmpegPath,
  ffprobePath,
  clearRenderArtifacts
} = require('./processor');

const {
  DownloadQueue,
  parseLinkList,
  resolveYtDlpPath,
  ytdlpExists,
  summarizeItems,
  clearQueueFiles,
  AUDIO_LANGUAGE_OPTIONS,
  DEFAULT_AUDIO_LANG,
  DEFAULT_PARALLEL_DOWNLOADS,
  normalizeConcurrency,
  normalizeAudioLang
} = require('./downloader');

const { analyzeRename, applyRename } = require('./renamer');

const VIDEO_FILTER = {
  name: 'Видео',
  extensions: VIDEO_EXTENSIONS.map((ext) => ext.replace('.', ''))
};

/** Высота полосы вкладок языков в shell.html (CSS px = DIP при масштабе 100%). */
const TAB_BAR_HEIGHT = 44;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 150;
const SHELL_STATE_INTERVAL_MS = 200;

/**
 * Пять независимых рабочих пространств. id постоянный — к нему привязаны
 * настройки, папки и очереди; название, флаг и код (он же префикс файлов
 * результата: esN.mp4, enN.mp4…) пользователь может поменять.
 */
const WORKSPACE_DEFAULTS = [
  { id: 'ws1', name: 'Español', code: 'es', flag: '🇪🇸' },
  { id: 'ws2', name: 'English', code: 'en', flag: '🇬🇧' },
  { id: 'ws3', name: 'Русский', code: 'ru', flag: '🇷🇺' },
  { id: 'ws4', name: 'Brasil', code: 'br', flag: '🇧🇷' },
  { id: 'ws5', name: 'Português', code: 'pt', flag: '🇵🇹' }
];

const FOLDER_LABELS = {
  sourceDir: 'папка исходников (монтаж)',
  outputDir: 'папка результата (монтаж)',
  downloadDir: 'папка скачивания',
  renameDir: 'папка переименования'
};

/** @type {BrowserWindow|null} */
let mainWindow = null;

// ---------------------------------------------------------------------------
// Конфигурация вкладок (userData/workspaces.json)
// ---------------------------------------------------------------------------

let config = null;
let configSaveTimer = null;

function configPath() {
  return path.join(app.getPath('userData'), 'workspaces.json');
}

function sanitizeName(value, fallback) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32);
  return text || fallback;
}

function sanitizeCode(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 8);
}

function sanitizeFlag(value, fallback) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim();
  return Array.from(text).slice(0, 4).join('') || fallback;
}

function loadConfig() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    saved = null;
  }
  const savedList = saved && Array.isArray(saved.workspaces) ? saved.workspaces : [];
  const usedCodes = new Set();
  const workspaces = WORKSPACE_DEFAULTS.map((def) => {
    const stored = savedList.find((item) => item && item.id === def.id) || {};
    let code = sanitizeCode(stored.code) || def.code;
    if (usedCodes.has(code)) code = def.code;
    usedCodes.add(code);
    const folders = {};
    Object.keys(FOLDER_LABELS).forEach((key) => {
      const value = stored.folders && typeof stored.folders[key] === 'string' ? stored.folders[key].trim() : '';
      if (value) folders[key] = value;
    });
    return {
      id: def.id,
      name: sanitizeName(stored.name, def.name),
      code,
      flag: sanitizeFlag(stored.flag, def.flag),
      folders
    };
  });
  const active = workspaces.some((ws) => saved && ws.id === saved.active) ? saved.active : workspaces[0].id;
  config = { active, workspaces };
}

function writeConfigNow() {
  if (configSaveTimer) {
    clearTimeout(configSaveTimer);
    configSaveTimer = null;
  }
  if (!config) return;
  try {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('Не удалось сохранить workspaces.json:', err);
  }
}

function saveConfigSoon() {
  if (configSaveTimer) clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(writeConfigNow, 300);
}

function getWs(id) {
  return config.workspaces.find((ws) => ws.id === id) || null;
}

function publicWs(ws) {
  const index = config.workspaces.indexOf(ws);
  const def = WORKSPACE_DEFAULTS.find((item) => item.id === ws.id);
  return {
    id: ws.id,
    index,
    name: ws.name,
    code: ws.code,
    flag: ws.flag,
    defaults: def ? { name: def.name, code: def.code, flag: def.flag } : null
  };
}

// ---------------------------------------------------------------------------
// Папки: ни одна папка не может принадлежать двум вкладкам
// ---------------------------------------------------------------------------

function normFolder(value) {
  if (!value || typeof value !== 'string' || !value.trim()) return null;
  let resolved = path.resolve(value.trim());
  if (resolved.length > 1) resolved = resolved.replace(/[\\/]+$/, '') || resolved;
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Совпадения папок вкладки wsId с папками всех остальных вкладок. */
function findFolderConflicts(wsId, folders) {
  const conflicts = [];
  Object.keys(FOLDER_LABELS).forEach((field) => {
    const mine = normFolder(folders && folders[field]);
    if (!mine) return;
    config.workspaces.forEach((other) => {
      if (other.id === wsId) return;
      Object.keys(FOLDER_LABELS).forEach((otherField) => {
        if (normFolder(other.folders[otherField]) !== mine) return;
        conflicts.push({
          field,
          label: FOLDER_LABELS[field],
          path: folders[field],
          otherId: other.id,
          otherName: `${other.flag} ${other.name}`,
          otherField,
          otherLabel: FOLDER_LABELS[otherField]
        });
      });
    });
  });
  return conflicts;
}

function conflictMessage(conflict) {
  return (
    `Папка «${conflict.path}» уже используется во вкладке ${conflict.otherName} ` +
    `(${conflict.otherLabel}). У каждой вкладки должны быть свои папки — выберите другую.`
  );
}

function broadcastConflicts() {
  runtime.forEach((rt, id) => {
    const ws = getWs(id);
    if (ws) send(id, 'workspace:conflicts', findFolderConflicts(id, ws.folders));
  });
}

// ---------------------------------------------------------------------------
// Состояние вкладок во время работы
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Runtime
 * @property {WebContentsView|null} view
 * @property {BatchProcessor|null} batch
 * @property {DownloadQueue|null} download
 * @property {boolean} detecting
 */

/** @type {Map<string, Runtime & Record<string, any>>} */
const runtime = new Map();
/** webContents.id → id вкладки */
const viewOwners = new Map();

function rtFor(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      view: null,
      batch: null,
      download: null,
      detecting: false,
      lastRender: null,
      lastDownload: null,
      downloadPaused: false,
      downloadProgressTimer: null,
      downloadProgressPending: null,
      downloadProgressAt: 0
    });
  }
  return runtime.get(id);
}

function send(id, channel, payload) {
  const rt = runtime.get(id);
  const contents = rt && rt.view && rt.view.webContents;
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

function broadcast(channel, payload) {
  runtime.forEach((_rt, id) => send(id, channel, payload));
}

/** Прогресс скачивания приходит на каждую строку yt-dlp — отдаём интерфейсу не чаще 150 мс. */
function sendDownloadProgress(id, state) {
  const rt = rtFor(id);
  rt.lastDownload = state;
  rt.downloadProgressPending = state;
  const wait = DOWNLOAD_PROGRESS_INTERVAL_MS - (Date.now() - rt.downloadProgressAt);
  if (wait <= 0) {
    flushDownloadProgress(id);
    return;
  }
  if (!rt.downloadProgressTimer) {
    rt.downloadProgressTimer = setTimeout(() => flushDownloadProgress(id), wait);
  }
}

function flushDownloadProgress(id) {
  const rt = rtFor(id);
  if (rt.downloadProgressTimer) {
    clearTimeout(rt.downloadProgressTimer);
    rt.downloadProgressTimer = null;
  }
  if (!rt.downloadProgressPending) return;
  const state = rt.downloadProgressPending;
  rt.downloadProgressPending = null;
  rt.downloadProgressAt = Date.now();
  send(id, 'download:progress', state);
  pushShellStateSoon();
}

function runtimeState(id) {
  const rt = rtFor(id);
  return {
    rendering: Boolean(rt.batch),
    downloading: Boolean(rt.download && rt.download.running),
    downloadPaused: Boolean(rt.download && rt.download.running && rt.downloadPaused),
    detecting: rt.detecting,
    lastRender: rt.batch ? rt.lastRender : null,
    lastDownload: rt.download ? rt.lastDownload : null
  };
}

// ---------------------------------------------------------------------------
// Окно: полоса вкладок (shell.html) + по одному WebContentsView на вкладку
// ---------------------------------------------------------------------------

let shellStateTimer = null;

function shellState() {
  return {
    active: config.active,
    workspaces: config.workspaces.map((ws) => {
      const rt = rtFor(ws.id);
      const render = rt.batch ? rt.lastRender : null;
      const download = rt.download && rt.download.running ? rt.lastDownload : null;
      return {
        ...publicWs(ws),
        opened: Boolean(rt.view),
        rendering: Boolean(rt.batch),
        renderPercent: render && Number.isFinite(Number(render.overallPercent)) ? Number(render.overallPercent) : 0,
        downloading: Boolean(rt.download && rt.download.running),
        downloadPaused: Boolean(rt.download && rt.download.running && rt.downloadPaused),
        downloadDone: download ? Number(download.completed) || 0 : 0,
        downloadTotal: download ? Number(download.total) || 0 : 0,
        conflicts: findFolderConflicts(ws.id, ws.folders).length
      };
    })
  };
}

function pushShellStateNow() {
  if (shellStateTimer) {
    clearTimeout(shellStateTimer);
    shellStateTimer = null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('shell:state', shellState());
  const ws = getWs(config.active);
  if (ws) mainWindow.setTitle(`Shorts Inserter — ${ws.flag} ${ws.name}`);
}

function pushShellStateSoon() {
  if (shellStateTimer) return;
  shellStateTimer = setTimeout(pushShellStateNow, SHELL_STATE_INTERVAL_MS);
}

function viewBounds() {
  const [width, height] = mainWindow.getContentSize();
  return { x: 0, y: TAB_BAR_HEIGHT, width: Math.max(0, width), height: Math.max(0, height - TAB_BAR_HEIGHT) };
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = viewBounds();
  runtime.forEach((rt) => {
    if (rt.view) rt.view.setBounds(bounds);
  });
}

function handleShortcut(event, input) {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
  if (/^[1-5]$/.test(input.key)) {
    const ws = config.workspaces[Number(input.key) - 1];
    if (ws) {
      event.preventDefault();
      activateWorkspace(ws.id);
    }
    return;
  }
  if (input.key === 'Tab') {
    event.preventDefault();
    const index = config.workspaces.findIndex((ws) => ws.id === config.active);
    const step = input.shift ? -1 : 1;
    const next = config.workspaces[(index + step + config.workspaces.length) % config.workspaces.length];
    activateWorkspace(next.id);
  }
}

function openExternalOnly(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
}

/** Вкладка создаётся при первом открытии — запуск программы не ждёт пять интерфейсов. */
function ensureView(id) {
  const rt = rtFor(id);
  if (rt.view) return rt.view;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  view.setBackgroundColor('#05070c');
  rt.view = view;
  const contents = view.webContents;
  viewOwners.set(contents.id, id);
  openExternalOnly(contents);
  contents.on('before-input-event', handleShortcut);
  contents.on('render-process-gone', (_event, details) => {
    console.error(`Вкладка ${id} упала: ${details && details.reason}`);
    if (details && details.reason !== 'clean-exit' && !contents.isDestroyed()) {
      setTimeout(() => {
        if (!contents.isDestroyed()) contents.reload();
      }, 500);
    }
  });
  mainWindow.contentView.addChildView(view);
  view.setBounds(viewBounds());
  view.setVisible(id === config.active);
  contents.loadFile(path.join(__dirname, 'index.html'), { query: { ws: id } });
  return view;
}

function activateWorkspace(id) {
  if (!getWs(id) || !mainWindow || mainWindow.isDestroyed()) return;
  config.active = id;
  saveConfigSoon();
  const view = ensureView(id);
  runtime.forEach((rt, otherId) => {
    if (rt.view) rt.view.setVisible(otherId === id);
  });
  view.webContents.focus();
  pushShellStateNow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 940,
    minWidth: 1040,
    minHeight: 740,
    show: false,
    backgroundColor: '#05070c',
    autoHideMenuBar: true,
    title: 'Shorts Inserter',
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  openExternalOnly(mainWindow.webContents);
  mainWindow.webContents.on('before-input-event', handleShortcut);
  mainWindow.loadFile(path.join(__dirname, 'shell.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', layoutViews);
  mainWindow.on('maximize', layoutViews);
  mainWindow.on('unmaximize', layoutViews);
  mainWindow.on('enter-full-screen', layoutViews);
  mainWindow.on('leave-full-screen', layoutViews);
  mainWindow.on('closed', () => {
    mainWindow = null;
    runtime.forEach((rt) => {
      rt.view = null;
    });
    viewOwners.clear();
  });

  activateWorkspace(config.active);
}

// ---------------------------------------------------------------------------
// IPC: каждый вызов из вкладки получает свою вкладку и только её данные
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, (event, payload) => {
    const id = viewOwners.get(event.sender.id);
    const ws = id ? getWs(id) : null;
    if (!ws) return { ok: false, error: 'Запрос пришёл не из вкладки программы.' };
    return fn(ws, payload == null ? {} : payload, rtFor(ws.id));
  });
}

function handleShell(channel, fn) {
  ipcMain.handle(channel, (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false };
    return fn(payload);
  });
}

handleShell('shell:get-state', () => shellState());
handleShell('shell:activate', (id) => {
  activateWorkspace(String(id));
  return { ok: true };
});

handle('workspace:get', (ws) => ({
  ok: true,
  workspace: publicWs(ws),
  state: runtimeState(ws.id),
  conflicts: findFolderConflicts(ws.id, ws.folders)
}));

handle('workspace:update', (ws, payload, rt) => {
  const name = sanitizeName(payload.name, ws.name);
  const flag = sanitizeFlag(payload.flag, ws.flag);
  const code = payload.code == null ? ws.code : sanitizeCode(payload.code);
  if (!code) return { ok: false, error: 'Код вкладки: 1–8 латинских букв или цифр (например es, en, ru).' };
  const taken = config.workspaces.find((other) => other.id !== ws.id && other.code === code);
  if (taken) return { ok: false, error: `Код «${code}» уже у вкладки ${taken.flag} ${taken.name}. Коды должны различаться.` };
  if (code !== ws.code && rt.batch) {
    return { ok: false, error: 'Нельзя менять код во время монтажа — он задаёт имена файлов результата.' };
  }
  ws.name = name;
  ws.flag = flag;
  ws.code = code;
  saveConfigSoon();
  send(ws.id, 'workspace:info', publicWs(ws));
  pushShellStateNow();
  return { ok: true, workspace: publicWs(ws) };
});

handle('workspace:set-folders', (ws, payload) => {
  const folders = {};
  Object.keys(FOLDER_LABELS).forEach((key) => {
    const value = typeof payload[key] === 'string' ? payload[key].trim() : '';
    if (value) folders[key] = value;
  });
  const changed = JSON.stringify(folders) !== JSON.stringify(ws.folders);
  ws.folders = folders;
  if (changed) {
    saveConfigSoon();
    broadcastConflicts();
    pushShellStateSoon();
  }
  return { ok: true, conflicts: findFolderConflicts(ws.id, ws.folders) };
});

handle('workspace:reset', (ws, _payload, rt) => {
  if (rt.batch || (rt.download && rt.download.running) || rt.detecting) {
    return { ok: false, error: 'Сначала остановите монтаж и скачивание в этой вкладке.' };
  }
  ws.folders = {};
  saveConfigSoon();
  broadcastConflicts();
  pushShellStateNow();
  return { ok: true };
});

handle('workspace:make-folders', async (ws) => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: `Общая папка проекта — в ней появится папка «${ws.code}» для вкладки ${ws.name}`,
    properties: ['openDirectory', 'createDirectory']
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
  const root = path.join(picked.filePaths[0], ws.code);
  const folders = {
    downloadDir: path.join(root, 'download'),
    renameDir: path.join(root, 'download'),
    sourceDir: path.join(root, 'download'),
    outputDir: path.join(root, 'montage')
  };
  const conflicts = findFolderConflicts(ws.id, folders);
  if (conflicts.length) return { ok: false, error: conflictMessage(conflicts[0]) };
  try {
    fs.mkdirSync(folders.downloadDir, { recursive: true });
    fs.mkdirSync(folders.outputDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Не удалось создать папки: ${err.message}` };
  }
  return { ok: true, folders };
});

handle('app:info', () => ({
  ok: true,
  version: app.getVersion(),
  encoders: Object.entries(ENCODERS).map(([value, preset]) => ({ value, label: preset.label })),
  exportModes: Object.entries(EXPORT_MODES).map(([value, mode]) => ({ value, label: mode.label })),
  resourceModes: Object.entries(RESOURCE_MODES).map(([value, mode]) => ({ value, label: mode.label })),
  parallelModes: Object.entries(PARALLEL_MODES).map(([value, mode]) => ({ value, label: mode.label })),
  frames: Object.entries(FRAME_PRESETS).map(([value, preset]) => ({ value, label: preset.label })),
  fits: Object.entries(FIT_MODES).map(([value, mode]) => ({ value, label: mode.label })),
  defaults: DEFAULTS,
  ffmpegPath,
  ffprobePath,
  ytdlpPath: resolveYtDlpPath(),
  ytdlpOk: ytdlpExists(resolveYtDlpPath())
}));

/** Проверка видеокарты общая для всех вкладок и не блокирует окно. */
handle('app:hardware', async () => {
  try {
    const hardware = await detectHardwareAsync();
    const gpuName = (hardware.h264 && hardware.h264.vendor) || (hardware.h265 && hardware.h265.vendor);
    return {
      ok: true,
      gpu: gpuName || null,
      compiledGpu: hardware.compiledGpu || [],
      probeError: hardware.probeError || null,
      hwaccel: hardware.hwaccel,
      cores: hardware.cores
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handle('workspace:state', (ws) => ({ ok: true, ...runtimeState(ws.id) }));

handle('dialog:pick-directory', async (_ws, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Выберите папку',
    defaultPath: options.defaultPath && fs.existsSync(options.defaultPath) ? options.defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

handle('dialog:pick-video', async (_ws, options) => {
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
handle('sources:scan', async (ws, payload) => {
  const { directory, outputDir } = payload;
  if (!directory || !fs.existsSync(directory)) return { count: 0, files: [], error: 'Папка не найдена' };
  try {
    const sameDir = outputDir && path.resolve(outputDir) === path.resolve(directory);
    const files = listVideoFiles(directory, { skipOutputNames: Boolean(sameDir), outputPrefix: ws.code });
    return { count: files.length, files: files.map((file) => path.basename(file)) };
  } catch (err) {
    return { count: 0, files: [], error: err.message };
  }
});

/** Короткая информация о выбранном файле (для подписи в интерфейсе). */
handle('media:describe', async (_ws, file) => {
  if (!file || typeof file !== 'string' || !fs.existsSync(file)) return { ok: false, error: 'Файл не найден' };
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

handle('shell:open-path', async (_ws, target) => {
  if (!target || typeof target !== 'string' || !fs.existsSync(target)) return { ok: false, error: 'Путь не найден' };
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true };
});

// ------------------------------------------------------------------ Монтаж

handle('processing:start', async (ws, settings, rt) => {
  if (rt.batch) return { ok: false, error: 'Монтаж в этой вкладке уже запущен' };
  const conflicts = findFolderConflicts(ws.id, { sourceDir: settings.sourceDir, outputDir: settings.outputDir });
  if (conflicts.length) return { ok: false, error: conflictMessage(conflicts[0]) };
  const requiredFiles = [
    ['shortsFile', 'Shorts', true],
    ['overlayFile', 'оверлея', settings.useOverlay],
    ['closeupFile', 'крупного плана', settings.useSplit]
  ];
  for (const [key, label, used] of requiredFiles) {
    const file = settings[key];
    if (!used || !file) continue;
    let stat = null;
    try { stat = fs.statSync(file); } catch (_) {}
    if (!stat) return { ok: false, error: `Файл ${label} не найден: ${file}` };
    if (!stat.isFile()) return { ok: false, error: `Для ${label} нужно выбрать видеофайл, а не папку: ${file}` };
  }

  const batch = new BatchProcessor({ ...settings, outputPrefix: ws.code }, {
    onLog: (level, message) => send(ws.id, 'processing:log', { level, message, time: Date.now() }),
    onProgress: (state) => {
      rt.lastRender = state;
      send(ws.id, 'processing:progress', state);
      pushShellStateSoon();
    }
  });

  rt.batch = batch;
  rt.lastRender = null;
  send(ws.id, 'processing:state', { running: true });
  pushShellStateNow();

  try {
    const summary = await batch.run();
    send(ws.id, 'processing:done', { ok: true, summary });
    return { ok: true, summary };
  } catch (err) {
    send(ws.id, 'processing:log', { level: 'error', message: err.message, time: Date.now() });
    send(ws.id, 'processing:done', { ok: false, error: err.message });
    return { ok: false, error: err.message, reported: true };
  } finally {
    rt.batch = null;
    rt.lastRender = null;
    send(ws.id, 'processing:state', { running: false });
    pushShellStateNow();
  }
});

handle('processing:stop', (_ws, _payload, rt) => {
  if (!rt.batch) return { ok: false, error: 'Монтаж не запущен' };
  rt.batch.stop();
  return { ok: true };
});

handle('processing:clear', (ws, payload, rt) => {
  if (rt.batch) return { ok: false, error: 'Сначала остановите монтаж.' };
  try {
    return { ok: true, ...clearRenderArtifacts({ outputDir: payload.outputDir, outputPrefix: ws.code }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// -------------------------------------------------------------- Скачивание

function downloadHooks(id) {
  return {
    onLog: (level, message) => send(id, 'download:log', { level, message, time: Date.now() }),
    onProgress: (state) => sendDownloadProgress(id, state)
  };
}

function queueSnapshot(queue, status = null) {
  const counts = summarizeItems(queue.items);
  return {
    ...counts,
    overallPercent: counts.total ? (counts.completed / counts.total) * 100 : 0,
    current: null,
    active: [],
    items: queue.items,
    errors: queue.items.filter(
      (item) => item.status === 'RETRY' || item.status === 'PERMANENT_ERROR' || item.status === 'SKIPPED'
    ),
    status
  };
}

/** Очередь из папки без запуска скачивания — для правок языка и проверки аудиодорожек. */
function openQueue(id, outputDir, withHooks) {
  const queue = new DownloadQueue({
    outputDir,
    ffmpegPath,
    ffprobePath,
    ytdlpPath: resolveYtDlpPath(),
    hooks: withHooks ? downloadHooks(id) : undefined
  });
  queue.items = queue.loadFromDisk();
  return queue;
}

function activeQueueFor(rt, outputDir) {
  const queue = rt.download;
  if (!queue || !queue.running) return null;
  return normFolder(queue.outputDir) === normFolder(outputDir) ? queue : null;
}

handle('download:parse', (_ws, text) => {
  const urls = parseLinkList(typeof text === 'string' ? text : '');
  return { ok: true, urls, count: urls.length };
});

handle('download:import-txt', async () => {
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
    return { ok: true, text: fs.readFileSync(result.filePaths[0], 'utf8'), file: result.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handle('download:load', (ws, outputDir, rt) => {
  if (!outputDir || typeof outputDir !== 'string' || !fs.existsSync(outputDir)) {
    return { ok: false, error: 'Папка не найдена' };
  }
  const running = activeQueueFor(rt, outputDir);
  if (running) {
    return {
      ok: true,
      urls: running.items.map((item) => item.url),
      audioOptions: AUDIO_LANGUAGE_OPTIONS,
      note: 'Идёт скачивание в эту папку.',
      progress: rt.lastDownload || queueSnapshot(running)
    };
  }
  if (findFolderConflicts(ws.id, { downloadDir: outputDir }).length) {
    return { ok: false, error: 'Папка принадлежит другой вкладке' };
  }
  if (rt.detecting) return { ok: false, error: 'Идёт проверка аудиодорожек' };
  const queue = openQueue(ws.id, outputDir, false);
  queue.reconcileExisting();
  const counts = summarizeItems(queue.items);
  return {
    ok: true,
    urls: queue.items.map((item) => item.url),
    audioOptions: AUDIO_LANGUAGE_OPTIONS,
    note: counts.total
      ? `Найдена сохранённая очередь: готово ${counts.completed} из ${counts.total}.`
      : 'В папке появятся видео, nazvaniya.txt, download_queue.json и download_log.txt.',
    progress: queueSnapshot(queue, counts.total ? `Очередь восстановлена: ${counts.completed} / ${counts.total}` : null)
  };
});

handle('download:start', async (ws, payload, rt) => {
  if (rt.download && rt.download.running) return { ok: false, error: 'Скачивание в этой вкладке уже запущено' };
  if (rt.detecting) return { ok: false, error: 'Дождитесь окончания проверки аудиодорожек.' };
  const outputDir = typeof payload.outputDir === 'string' ? payload.outputDir.trim() : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!outputDir) return { ok: false, error: 'Не выбрана папка для сохранения.' };
  const conflicts = findFolderConflicts(ws.id, { downloadDir: outputDir });
  if (conflicts.length) return { ok: false, error: conflictMessage(conflicts[0]) };
  if (!ffmpegPath || (ffmpegPath !== 'ffmpeg' && !fs.existsSync(ffmpegPath))) {
    return { ok: false, error: 'FFmpeg не найден. Установите/укажите путь к FFmpeg.' };
  }
  const ytdlpPath = resolveYtDlpPath();
  if (!ytdlpExists(ytdlpPath)) {
    return { ok: false, error: 'yt-dlp не найден. Переустановите программу или положите yt-dlp в vendor/yt-dlp.' };
  }
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Не удалось создать папку: ${err.message}` };
  }

  const queue = new DownloadQueue({
    outputDir,
    ffmpegPath,
    ffprobePath,
    ytdlpPath,
    concurrency: normalizeConcurrency(payload.concurrency, DEFAULT_PARALLEL_DOWNLOADS),
    hooks: downloadHooks(ws.id)
  });
  // «Язык аудио по умолчанию» применяется только к новым ссылкам.
  queue.setLinks(text, { defaultAudioLang: payload.defaultAudioLang || DEFAULT_AUDIO_LANG });
  if (!queue.items.length) return { ok: false, error: 'В списке нет распознанных ссылок YouTube.' };

  // Индивидуальные языки из UI: { "<номер или url>": "ru" }.
  const audioLangs = payload.audioLangs && typeof payload.audioLangs === 'object' ? payload.audioLangs : null;
  if (audioLangs) {
    queue.items.forEach((item) => {
      const byNumber = audioLangs[String(item.number)];
      const byUrl = audioLangs[item.url];
      const value = byNumber != null ? byNumber : byUrl;
      if (value != null) item.audioLang = normalizeAudioLang(value);
    });
    queue.persist();
  }

  rt.download = queue;
  rt.downloadPaused = false;
  rt.lastDownload = null;
  send(ws.id, 'download:state', { running: true, paused: false });
  pushShellStateNow();
  try {
    const summary = await queue.run();
    flushDownloadProgress(ws.id);
    send(ws.id, 'download:done', { ok: true, summary });
    return { ok: true, summary };
  } catch (err) {
    flushDownloadProgress(ws.id);
    send(ws.id, 'download:log', { level: 'error', message: err.message, time: Date.now() });
    send(ws.id, 'download:done', { ok: false, error: err.message });
    return { ok: false, error: err.message, reported: true };
  } finally {
    if (rt.download === queue) rt.download = null;
    rt.downloadPaused = false;
    send(ws.id, 'download:state', { running: false, paused: false });
    pushShellStateNow();
  }
});

handle('download:pause', (ws, _payload, rt) => {
  if (!rt.download || !rt.download.running) return { ok: false, error: 'Скачивание не запущено' };
  rt.download.pause();
  rt.downloadPaused = true;
  send(ws.id, 'download:state', { running: true, paused: true });
  pushShellStateNow();
  return { ok: true };
});

handle('download:resume', (ws, _payload, rt) => {
  if (!rt.download || !rt.download.running) return { ok: false, error: 'Скачивание не запущено' };
  rt.download.resume();
  rt.downloadPaused = false;
  send(ws.id, 'download:state', { running: true, paused: false });
  pushShellStateNow();
  return { ok: true };
});

handle('download:stop', (_ws, _payload, rt) => {
  if (!rt.download || !rt.download.running) return { ok: false, error: 'Скачивание не запущено' };
  rt.download.stop();
  return { ok: true };
});

// Список языков для выпадающих списков в UI (единый источник истины — downloader.js).
handle('download:audio-langs', () => ({
  ok: true,
  options: AUDIO_LANGUAGE_OPTIONS,
  defaultLang: DEFAULT_AUDIO_LANG
}));

// Индивидуальная и массовая установка языка (работает и во время скачивания).
handle('download:set-audio-lang', (ws, payload, rt) => {
  const lang = normalizeAudioLang(payload.lang);
  const numbers = Array.isArray(payload.numbers) ? payload.numbers.map(Number) : [];
  const outputDir = payload.outputDir;
  const running = activeQueueFor(rt, outputDir);
  if (running) {
    const changed = running.setItemsAudioLang(numbers, lang);
    return { ok: true, changed, lang, progress: queueSnapshot(running) };
  }
  if (!outputDir || !fs.existsSync(outputDir)) return { ok: false, error: 'Папка не найдена' };
  if (findFolderConflicts(ws.id, { downloadDir: outputDir }).length) {
    return { ok: false, error: 'Папка принадлежит другой вкладке' };
  }
  if (rt.detecting) return { ok: false, error: 'Идёт проверка аудиодорожек — повторите через несколько секунд.' };
  try {
    const queue = openQueue(ws.id, outputDir, false);
    const changed = queue.setItemsAudioLang(numbers, lang);
    return { ok: true, changed, lang, progress: queueSnapshot(queue) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Определение доступных аудиодорожек без скачивания.
handle('download:detect-audio', async (ws, payload, rt) => {
  if (rt.download && rt.download.running) {
    return { ok: false, error: 'Скачивание запущено — языки определяются автоматически перед каждым видео.' };
  }
  if (rt.detecting) return { ok: false, error: 'Проверка аудиодорожек уже идёт.' };
  const outputDir = payload.outputDir;
  if (!outputDir || !fs.existsSync(outputDir)) return { ok: false, error: 'Папка не найдена' };
  const conflicts = findFolderConflicts(ws.id, { downloadDir: outputDir });
  if (conflicts.length) return { ok: false, error: conflictMessage(conflicts[0]) };
  const ytdlpPath = resolveYtDlpPath();
  if (!ytdlpExists(ytdlpPath)) {
    return { ok: false, error: 'yt-dlp не найден. Переустановите программу или положите yt-dlp в vendor/yt-dlp.' };
  }
  rt.detecting = true;
  try {
    const queue = openQueue(ws.id, outputDir, true);
    if (!queue.items.length) {
      return { ok: false, error: 'Очередь пуста. Сначала добавьте ссылки и запустите скачивание или загрузку очереди.' };
    }
    const results = await queue.detectAudio({
      numbers: Array.isArray(payload.numbers) ? payload.numbers.map(Number) : [],
      onlyUnchecked: Boolean(payload.onlyUnchecked)
    });
    flushDownloadProgress(ws.id);
    return { ok: true, results, progress: queueSnapshot(queue) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    rt.detecting = false;
  }
});

handle('download:clear', (ws, payload, rt) => {
  if ((rt.download && rt.download.running) || rt.detecting) {
    return { ok: false, error: 'Сначала остановите скачивание.' };
  }
  const outputDir = payload.outputDir;
  if (!outputDir || !fs.existsSync(outputDir)) return { ok: false, error: 'Папка не найдена' };
  const conflicts = findFolderConflicts(ws.id, { downloadDir: outputDir });
  if (conflicts.length) return { ok: false, error: conflictMessage(conflicts[0]) };
  try {
    const result = clearQueueFiles(outputDir, { clearLog: payload.clearLog !== false });
    rt.download = null;
    rt.lastDownload = null;
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ----------------------------------------------------------- Переименование

handle('rename:detect-txt', (_ws, directory) => {
  if (!directory || typeof directory !== 'string' || !fs.existsSync(directory)) return { ok: false };
  const guessed = path.join(directory, 'nazvaniya.txt');
  if (fs.existsSync(guessed)) return { ok: true, file: guessed };
  return { ok: false };
});

handle('rename:pick-txt', async (_ws, options) => {
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

handle('rename:analyze', (_ws, payload) => {
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

handle('rename:apply', (ws, payload, rt) => {
  const conflicts = findFolderConflicts(ws.id, { renameDir: payload.directory });
  if (conflicts.length) return { ok: false, error: conflictMessage(conflicts[0]) };
  if (activeQueueFor(rt, payload.directory)) {
    return { ok: false, error: 'В эту папку сейчас идёт скачивание — переименование после его окончания.' };
  }
  if (rt.batch && normFolder(rt.batch.settings.sourceDir) === normFolder(payload.directory)) {
    return { ok: false, error: 'Эта папка сейчас монтируется — переименование после окончания монтажа.' };
  }
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

// ---------------------------------------------------------------------------
// Жизненный цикл приложения
// ---------------------------------------------------------------------------

function stopEverything() {
  runtime.forEach((rt) => {
    if (rt.batch) rt.batch.stop();
    if (rt.download && rt.download.running) rt.download.stop();
  });
}

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
    loadConfig();
    detectHardwareAsync().catch((err) => console.error('Проверка видеокарты:', err));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  stopEverything();
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(err);
  broadcast('processing:log', {
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
  broadcast('processing:log', { level: 'error', message: `Сбой: ${message}`, time: Date.now() });
});

app.on('before-quit', () => {
  stopEverything();
  writeConfigNow();
});
