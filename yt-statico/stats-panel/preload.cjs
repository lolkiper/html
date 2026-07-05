const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('statsPanel', {
  getPaths: () => ipcRenderer.invoke('paths'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  loadChannels: () => ipcRenderer.invoke('load-channels'),
  saveChannels: (text) => ipcRenderer.invoke('save-channels', text),
  loadResults: () => ipcRenderer.invoke('load-results'),
  loadAccountsPreview: () => ipcRenderer.invoke('load-accounts-preview'),
  startStats: () => ipcRenderer.invoke('start-stats'),
  stopStats: () => ipcRenderer.invoke('stop-stats'),
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
  onStatsFinished: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('stats-finished', handler);
    return () => ipcRenderer.removeListener('stats-finished', handler);
  },
});
