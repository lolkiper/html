'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellApi', {
  getState: () => ipcRenderer.invoke('shell:get-state'),
  activate: (id) => ipcRenderer.invoke('shell:activate', id),
  onState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('shell:state', listener);
    return () => ipcRenderer.removeListener('shell:state', listener);
  }
});
