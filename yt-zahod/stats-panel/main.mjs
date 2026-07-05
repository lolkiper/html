import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDirs() {
  const isPackaged = app.isPackaged;
  return {
    panelDir: __dirname,
    farmDir: isPackaged
      ? path.join(process.resourcesPath, 'yt-zahod')
      : path.join(__dirname, '..'),
    baseDir: isPackaged
      ? path.dirname(process.execPath)
      : process.cwd(),
  };
}

function getPaths() {
  const { farmDir, baseDir } = getDirs();
  return {
    CONFIG_FILE: path.join(baseDir, 'stats-config.json'),
    ONBOARD_CONFIG_FILE: path.join(baseDir, 'onboard-config.json'),
    ACCOUNTS_FILE: path.join(baseDir, 'accounts.txt'),
    CHANNELS_FILE: path.join(baseDir, 'channels.txt'),
    RESULTS_FILE: path.join(baseDir, 'channel-stats-results.json'),
    ONBOARD_RESULTS_FILE: path.join(baseDir, 'onboard-results.json'),
    EXAMPLE_CONFIG: path.join(farmDir, 'stats-config.example.json'),
    EXAMPLE_CHANNELS: path.join(farmDir, 'channels.example.txt'),
    YT_ZAHOD_DIR: farmDir,
    baseDir,
  };
}

let mainWindow = null;
let workerChild = null;

function ensureDefaults() {
  const p = getPaths();
  if (!fs.existsSync(p.CONFIG_FILE)) {
    if (fs.existsSync(p.EXAMPLE_CONFIG)) {
      fs.copyFileSync(p.EXAMPLE_CONFIG, p.CONFIG_FILE);
    } else if (fs.existsSync(p.ONBOARD_CONFIG_FILE)) {
      const onboard = JSON.parse(fs.readFileSync(p.ONBOARD_CONFIG_FILE, 'utf-8'));
      const merged = {
        ...onboard,
        CHANNELS_FILE: 'channels.txt',
        STATS_RESULTS_FILE: 'channel-stats-results.json',
        DELAY_BETWEEN_CHANNELS_MS: onboard.DELAY_BETWEEN_CHANNELS_MS ?? onboard.DELAY_BETWEEN_ACCOUNTS_MS ?? 5000,
      };
      fs.writeFileSync(p.CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    }
  }
  if (!fs.existsSync(p.CHANNELS_FILE) && fs.existsSync(p.EXAMPLE_CHANNELS)) {
    fs.copyFileSync(p.EXAMPLE_CHANNELS, p.CHANNELS_FILE);
  }
}

function sendLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-line', line);
  }
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', status);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'YouTube Channel Stats',
    backgroundColor: '#0a0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  ensureDefaults();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (workerChild) workerChild.kill('SIGTERM');
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('paths', () => {
  const p = getPaths();
  return {
    baseDir: p.baseDir,
    configFile: p.CONFIG_FILE,
    accountsFile: p.ACCOUNTS_FILE,
    channelsFile: p.CHANNELS_FILE,
    resultsFile: p.RESULTS_FILE,
    onboardResultsFile: p.ONBOARD_RESULTS_FILE,
  };
});

ipcMain.handle('load-config', () => {
  const p = getPaths();
  ensureDefaults();
  if (!fs.existsSync(p.CONFIG_FILE)) return {};
  return JSON.parse(fs.readFileSync(p.CONFIG_FILE, 'utf-8'));
});

ipcMain.handle('save-config', (_e, config) => {
  const p = getPaths();
  fs.writeFileSync(p.CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('load-channels', () => {
  const p = getPaths();
  ensureDefaults();
  if (!fs.existsSync(p.CHANNELS_FILE)) return '';
  return fs.readFileSync(p.CHANNELS_FILE, 'utf-8');
});

ipcMain.handle('save-channels', (_e, text) => {
  const p = getPaths();
  fs.writeFileSync(p.CHANNELS_FILE, text, 'utf-8');
  return true;
});

ipcMain.handle('load-results', () => {
  const p = getPaths();
  if (!fs.existsSync(p.RESULTS_FILE)) return { channels: [], updatedAt: null };
  try {
    return JSON.parse(fs.readFileSync(p.RESULTS_FILE, 'utf-8'));
  } catch {
    return { channels: [], updatedAt: null };
  }
});

ipcMain.handle('load-accounts-preview', () => {
  const p = getPaths();
  if (!fs.existsSync(p.ACCOUNTS_FILE)) return [];
  const lines = fs.readFileSync(p.ACCOUNTS_FILE, 'utf-8').split(/\r?\n/);
  const accounts = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|');
    accounts.push({
      email: parts[0]?.trim() || '',
      profileName: parts[4]?.trim() || parts[0]?.split('@')[0] || '',
    });
  }
  return accounts;
});

ipcMain.handle('is-running', () => Boolean(workerChild));

ipcMain.handle('start-stats', async () => {
  if (workerChild) {
    throw new Error('Сбор статистики уже запущен');
  }

  const p = getPaths();
  const script = path.join(p.YT_ZAHOD_DIR, 'channel-stats.mjs');
  if (!fs.existsSync(script)) {
    throw new Error(`Не найден ${script}`);
  }

  sendStatus('running');
  sendLog(`[Panel] Старт сбора статистики, cwd=${p.baseDir}`);

  const env = { ...process.env };
  if (process.versions?.electron) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  const asarNodeModules = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'node_modules')
    : path.join(__dirname, '..', 'node_modules');
  const nodePathParts = [asarNodeModules, env.NODE_PATH].filter(Boolean);
  env.NODE_PATH = nodePathParts.join(path.delimiter);

  workerChild = spawn(process.execPath, [script], {
    cwd: p.baseDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const onData = (chunk) => {
    String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => sendLog(line));
  };

  workerChild.stdout.on('data', onData);
  workerChild.stderr.on('data', onData);

  workerChild.on('exit', (code, signal) => {
    sendLog(`[Panel] Процесс завершён (code=${code}, signal=${signal || 'none'})`);
    workerChild = null;
    sendStatus('idle');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stats-finished');
    }
  });

  workerChild.on('error', (err) => {
    sendLog(`[Panel] Ошибка spawn: ${err.message}`);
    workerChild = null;
    sendStatus('idle');
  });

  return true;
});

ipcMain.handle('stop-stats', () => {
  if (!workerChild) return false;
  workerChild.kill('SIGTERM');
  sendLog('[Panel] Остановка по запросу пользователя...');
  return true;
});
