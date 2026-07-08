import { app, BrowserWindow, ipcMain, Menu, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  createFarmOrchestrator,
  getConfigPath,
  loadConfig,
  mergeGuiConfig,
  saveConfig,
} from './farm-orchestrator.mjs';
import { applyFarmModePreset } from './mode-presets.mjs';
import {
  applyModeSettingsToConfig,
  getModeSettings,
  migrateModeSettings,
  normalizeMode,
  saveModeSnapshot,
} from './mode-settings.mjs';
import { ensureFarmScripts } from './ensure-farm-scripts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getBaseDir() {
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

let mainWindow = null;
let orchestrator = null;

function getErrorLogPath() {
  return path.join(getBaseDir(), 'zaliver-error.log');
}

function logStartupError(label, err) {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  const line = `[${new Date().toISOString()}] ${label}: ${message}\n`;
  console.error(line);
  try {
    fs.appendFileSync(getErrorLogPath(), line, 'utf-8');
  } catch {
    /* ignore log write errors */
  }
}

function sendLog(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('farm-log', data);
  }
}

function ensureConfigFile() {
  const baseDir = getBaseDir();
  const configPath = getConfigPath(baseDir);
  const examplePath = path.join(baseDir, 'config.example.json');
  const exampleFallback = path.join(__dirname, '..', 'config.example.json');
  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, configPath);
    } else if (fs.existsSync(exampleFallback)) {
      fs.copyFileSync(exampleFallback, configPath);
    }
  }
}

function createWindow() {
  // ~37% × ~54% экрана 1920×1080 — как на референсе пользователя
  const WIN_W = 720;
  const WIN_H = 580;

  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    useContentSize: true,
    minWidth: WIN_W,
    maxWidth: WIN_W,
    minHeight: WIN_H,
    maxHeight: WIN_H,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'YouTube Zaliver v1.2',
    backgroundColor: '#07030d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function getOrchestrator() {
  if (!orchestrator) {
    orchestrator = createFarmOrchestrator({
      baseDir: getBaseDir(),
      onLog: sendLog,
    });
  }
  return orchestrator;
}

function wrapIpc(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      logStartupError('IPC', err);
      throw err;
    }
  };
}

process.on('uncaughtException', (err) => {
  logStartupError('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  logStartupError('unhandledRejection', reason);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  const baseDir = getBaseDir();
  try {
    const { copied, missing } = ensureFarmScripts(baseDir, __dirname);
    if (copied.length) {
      console.log(`[Zaliver] Скопированы скрипты фермы: ${copied.join(', ')}`);
    }
    if (missing.length) {
      const text = `Не найдены файлы: ${missing.join(', ')}\n\nПапка запуска:\n${baseDir}\n\nСкопируйте main.mjs и youtube-studio.mjs в эту папку или пересоберите через СБОРКА.bat`;
      logStartupError('ensureFarmScripts', new Error(text));
      dialog.showErrorBox('YouTube Zaliver — ошибка запуска', text);
    }
    ensureConfigFile();
    createWindow();
  } catch (err) {
    logStartupError('startup', err);
    dialog.showErrorBox('YouTube Zaliver — ошибка запуска', err.message || String(err));
    app.quit();
    return;
  }

  ipcMain.handle('get-config', wrapIpc(() => {
    const raw = loadConfig(baseDir);
    if (!raw) return null;
    const migrated = migrateModeSettings(raw);
    const mode = normalizeMode(migrated.FARM_MODE);
    const withModeFields = applyModeSettingsToConfig(migrated, mode);
    const preset = applyFarmModePreset(withModeFields, mode);
    return {
      ...preset,
      MODE_SETTINGS: migrated.MODE_SETTINGS,
      modeSettings: getModeSettings(migrated, mode),
    };
  }));

  ipcMain.handle('set-farm-mode', wrapIpc((_event, payload) => {
    const mode = normalizeMode(typeof payload === 'string' ? payload : payload?.mode);
    const snapshot = typeof payload === 'object' ? payload?.snapshot : null;

    let existing = migrateModeSettings(loadConfig(baseDir) || {});

    if (snapshot?.forMode) {
      existing = saveModeSnapshot(existing, snapshot.forMode, snapshot);
    }

    existing.FARM_MODE = mode;
    const withFields = applyModeSettingsToConfig(existing, mode);
    const updated = applyFarmModePreset(withFields, mode);
    updated.MODE_SETTINGS = existing.MODE_SETTINGS;
    saveConfig(baseDir, updated);

    return {
      FARM_MODE: updated.FARM_MODE,
      SCHEDULE_SETTINGS: updated.SCHEDULE_SETTINGS,
      modeSettings: getModeSettings(updated, mode),
    };
  }));

  ipcMain.handle('start-farm', wrapIpc((_event, guiConfig) => {
    const { missing } = ensureFarmScripts(baseDir, __dirname);
    if (missing.length) {
      throw new Error(`Не найдены скрипты: ${missing.join(', ')}. Положите их в ${baseDir}`);
    }
    const merged = mergeGuiConfig(baseDir, guiConfig);
    saveConfig(baseDir, merged);
    return getOrchestrator().start(merged);
  }));

  ipcMain.handle('stop-farm', wrapIpc(() => {
    getOrchestrator().stop();
    return true;
  }));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
