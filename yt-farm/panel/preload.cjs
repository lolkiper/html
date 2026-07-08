const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setFarmMode: (mode, snapshot) => ipcRenderer.invoke('set-farm-mode', { mode, snapshot }),
  startFarm: (guiConfig) => ipcRenderer.invoke('start-farm', guiConfig),
  stopFarm: () => ipcRenderer.invoke('stop-farm'),
  onLogMessage: (callback) => {
    ipcRenderer.on('farm-log', (_event, data) => callback(data));
  },
});
