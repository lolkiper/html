import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  createFarmOrchestrator,
  getFarmPaths,
  loadConfig,
  mergeGuiConfig,
  saveConfig,
} from './farm-orchestrator.mjs';
import { applyFarmModePreset } from './mode-presets.mjs';
import { ensureFarmScripts } from './ensure-farm-scripts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getBaseDir() {
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

let mainWindow = null;
let orchestrator = null;

function sendLog(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('farm-log', data);
  }
}

function ensureConfigFile() {
  const baseDir = getBaseDir();
  const { configPath } = getFarmPaths(baseDir);
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
  mainWindow = new BrowserWindow({
    width: 980,
    height: 920,
    minWidth: 860,
    minHeight: 700,
    title: 'YouTube Zaliver v1.2',
    backgroundColor: '#07030d',
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

app.whenReady().then(() => {
  const baseDir = getBaseDir();
  const copied = ensureFarmScripts(baseDir, __dirname);
  if (copied.length) {
    console.log(`[Zaliver] Скопированы скрипты фермы: ${copied.join(', ')}`);
  }
  ensureConfigFile();
  createWindow();

  ipcMain.handle('get-config', () => {
    const raw = loadConfig(baseDir);
    if (!raw) return null;
    return applyFarmModePreset(raw, raw.FARM_MODE);
  });

  ipcMain.handle('set-farm-mode', (_event, mode) => {
    const existing = loadConfig(baseDir) || {};
    const updated = applyFarmModePreset(existing, mode);
    saveConfig(baseDir, updated);
    return {
      FARM_MODE: updated.FARM_MODE,
      SCHEDULE_SETTINGS: updated.SCHEDULE_SETTINGS,
    };
  });

  ipcMain.handle('start-farm', (_event, guiConfig) => {
    ensureFarmScripts(baseDir, __dirname);
    const merged = mergeGuiConfig(baseDir, guiConfig);
    saveConfig(baseDir, merged);
    return getOrchestrator().start(merged);
  });

  ipcMain.handle('stop-farm', () => {
    getOrchestrator().stop();
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
