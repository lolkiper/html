const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setFarmMode: (mode) => ipcRenderer.invoke('set-farm-mode', mode),
  startFarm: (guiConfig) => ipcRenderer.invoke('start-farm', guiConfig),
  stopFarm: () => ipcRenderer.invoke('stop-farm'),
  onLogMessage: (callback) => {
    ipcRenderer.on('farm-log', (_event, data) => callback(data));
  },
});
