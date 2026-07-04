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
      ? path.join(process.resourcesPath, 'yt-farm')
      : path.join(__dirname, '..'),
    baseDir: isPackaged
      ? path.dirname(process.execPath)
      : process.cwd(),
  };
}

function getPaths() {
  const { farmDir, baseDir } = getDirs();
  return {
    CONFIG_FILE: path.join(baseDir, 'onboard-config.json'),
    ACCOUNTS_FILE: path.join(baseDir, 'accounts.txt'),
    RESULTS_FILE: path.join(baseDir, 'onboard-results.json'),
    EXAMPLE_CONFIG: path.join(farmDir, 'onboard-config.example.json'),
    EXAMPLE_ACCOUNTS: path.join(farmDir, 'accounts.example.txt'),
    YT_FARM_DIR: farmDir,
    baseDir,
  };
}

let mainWindow = null;
let workerChild = null;

function ensureDefaults() {
  const p = getPaths();
  if (!fs.existsSync(p.CONFIG_FILE) && fs.existsSync(p.EXAMPLE_CONFIG)) {
    fs.copyFileSync(p.EXAMPLE_CONFIG, p.CONFIG_FILE);
  }
  if (!fs.existsSync(p.ACCOUNTS_FILE) && fs.existsSync(p.EXAMPLE_ACCOUNTS)) {
    fs.copyFileSync(p.EXAMPLE_ACCOUNTS, p.ACCOUNTS_FILE);
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
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'YouTube Onboard Panel',
    backgroundColor: '#0f1117',
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
    resultsFile: p.RESULTS_FILE,
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

ipcMain.handle('load-accounts', () => {
  const p = getPaths();
  ensureDefaults();
  if (!fs.existsSync(p.ACCOUNTS_FILE)) return '';
  return fs.readFileSync(p.ACCOUNTS_FILE, 'utf-8');
});

ipcMain.handle('save-accounts', (_e, text) => {
  const p = getPaths();
  fs.writeFileSync(p.ACCOUNTS_FILE, text, 'utf-8');
  return true;
});

ipcMain.handle('load-results', () => {
  const p = getPaths();
  if (!fs.existsSync(p.RESULTS_FILE)) return { accounts: [] };
  try {
    return JSON.parse(fs.readFileSync(p.RESULTS_FILE, 'utf-8'));
  } catch {
    return { accounts: [] };
  }
});

ipcMain.handle('is-running', () => Boolean(workerChild));

ipcMain.handle('start-onboard', async () => {
  if (workerChild) {
    throw new Error('Онбординг уже запущен');
  }

  const p = getPaths();
  const script = path.join(p.YT_FARM_DIR, 'account-onboard.mjs');
  if (!fs.existsSync(script)) {
    throw new Error(`Не найден ${script}`);
  }

  sendStatus('running');
  sendLog(`[Panel] Старт онбординга, cwd=${p.baseDir}`);

  const env = { ...process.env };
  if (process.versions?.electron) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

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
  });

  workerChild.on('error', (err) => {
    sendLog(`[Panel] Ошибка spawn: ${err.message}`);
    workerChild = null;
    sendStatus('idle');
  });

  return true;
});

ipcMain.handle('stop-onboard', () => {
  if (!workerChild) return false;
  workerChild.kill('SIGTERM');
  sendLog('[Panel] Остановка по запросу пользователя...');
  return true;
});
