const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onboardPanel', {
  getPaths: () => ipcRenderer.invoke('paths'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  loadAccounts: () => ipcRenderer.invoke('load-accounts'),
  saveAccounts: (text) => ipcRenderer.invoke('save-accounts', text),
  loadResults: () => ipcRenderer.invoke('load-results'),
  startOnboard: () => ipcRenderer.invoke('start-onboard'),
  stopOnboard: () => ipcRenderer.invoke('stop-onboard'),
  isRunning: () => ipcRenderer.invoke('is-running'),
  onLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('log-line', handler);
    return () => ipcRenderer.removeListener('log-line', handler);
  },
  onStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
});
