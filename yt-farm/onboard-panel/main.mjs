import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YT_FARM_DIR = path.join(__dirname, '..');
const baseDir = process.cwd();

const CONFIG_FILE = path.join(baseDir, 'onboard-config.json');
const ACCOUNTS_FILE = path.join(baseDir, 'accounts.txt');
const RESULTS_FILE = path.join(baseDir, 'onboard-results.json');
const EXAMPLE_CONFIG = path.join(YT_FARM_DIR, 'onboard-config.example.json');
const EXAMPLE_ACCOUNTS = path.join(YT_FARM_DIR, 'accounts.example.txt');

let mainWindow = null;
let workerChild = null;

function ensureDefaults() {
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(EXAMPLE_CONFIG)) {
    fs.copyFileSync(EXAMPLE_CONFIG, CONFIG_FILE);
  }
  if (!fs.existsSync(ACCOUNTS_FILE) && fs.existsSync(EXAMPLE_ACCOUNTS)) {
    fs.copyFileSync(EXAMPLE_ACCOUNTS, ACCOUNTS_FILE);
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

ipcMain.handle('paths', () => ({
  baseDir,
  configFile: CONFIG_FILE,
  accountsFile: ACCOUNTS_FILE,
  resultsFile: RESULTS_FILE,
}));

ipcMain.handle('load-config', () => {
  ensureDefaults();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
});

ipcMain.handle('save-config', (_e, config) => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('load-accounts', () => {
  ensureDefaults();
  if (!fs.existsSync(ACCOUNTS_FILE)) return '';
  return fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
});

ipcMain.handle('save-accounts', (_e, text) => {
  fs.writeFileSync(ACCOUNTS_FILE, text, 'utf-8');
  return true;
});

ipcMain.handle('load-results', () => {
  if (!fs.existsSync(RESULTS_FILE)) return { accounts: [] };
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  } catch {
    return { accounts: [] };
  }
});

ipcMain.handle('is-running', () => Boolean(workerChild));

ipcMain.handle('start-onboard', async () => {
  if (workerChild) {
    throw new Error('Онбординг уже запущен');
  }

  const script = path.join(YT_FARM_DIR, 'account-onboard.mjs');
  if (!fs.existsSync(script)) {
    throw new Error(`Не найден ${script}`);
  }

  sendStatus('running');
  sendLog(`[Panel] Старт онбординга, cwd=${baseDir}`);

  const env = { ...process.env };
  if (process.versions?.electron) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  workerChild = spawn(process.execPath, [script], {
    cwd: baseDir,
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
