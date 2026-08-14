'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Подписка с корректной отпиской: наружу отдаём только полезную нагрузку. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  pickDirectory: (options) => ipcRenderer.invoke('dialog:pick-directory', options),
  pickVideo: (options) => ipcRenderer.invoke('dialog:pick-video', options),

  scanSources: (payload) => ipcRenderer.invoke('sources:scan', payload),
  describeMedia: (file) => ipcRenderer.invoke('media:describe', file),
  openPath: (target) => ipcRenderer.invoke('shell:open-path', target),

  startProcessing: (settings) => ipcRenderer.invoke('processing:start', settings),
  stopProcessing: () => ipcRenderer.invoke('processing:stop'),

  onLog: (callback) => subscribe('processing:log', callback),
  onProgress: (callback) => subscribe('processing:progress', callback),
  onState: (callback) => subscribe('processing:state', callback),
  onDone: (callback) => subscribe('processing:done', callback)
});
