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
  getHardware: () => ipcRenderer.invoke('app:hardware'),

  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  getWorkspaceState: () => ipcRenderer.invoke('workspace:state'),
  updateWorkspace: (payload) => ipcRenderer.invoke('workspace:update', payload),
  setWorkspaceFolders: (payload) => ipcRenderer.invoke('workspace:set-folders', payload),
  resetWorkspace: () => ipcRenderer.invoke('workspace:reset'),
  makeWorkspaceFolders: () => ipcRenderer.invoke('workspace:make-folders'),
  onWorkspaceInfo: (callback) => subscribe('workspace:info', callback),
  onWorkspaceConflicts: (callback) => subscribe('workspace:conflicts', callback),

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
  onDone: (callback) => subscribe('processing:done', callback),

  parseDownloadLinks: (text) => ipcRenderer.invoke('download:parse', text),
  importDownloadTxt: () => ipcRenderer.invoke('download:import-txt'),
  loadDownloadQueue: (outputDir) => ipcRenderer.invoke('download:load', outputDir),
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  pauseDownload: () => ipcRenderer.invoke('download:pause'),
  resumeDownload: () => ipcRenderer.invoke('download:resume'),
  stopDownload: () => ipcRenderer.invoke('download:stop'),

  onDownloadLog: (callback) => subscribe('download:log', callback),
  onDownloadProgress: (callback) => subscribe('download:progress', callback),
  onDownloadState: (callback) => subscribe('download:state', callback),
  onDownloadDone: (callback) => subscribe('download:done', callback),

  detectRenameTxt: (directory) => ipcRenderer.invoke('rename:detect-txt', directory),
  pickRenameTxt: (options) => ipcRenderer.invoke('rename:pick-txt', options),
  analyzeRename: (payload) => ipcRenderer.invoke('rename:analyze', payload),
  applyRename: (payload) => ipcRenderer.invoke('rename:apply', payload),

  getAudioLanguages: () => ipcRenderer.invoke('download:audio-langs'),
  setDownloadAudioLang: (payload) => ipcRenderer.invoke('download:set-audio-lang', payload),
  detectDownloadAudio: (payload) => ipcRenderer.invoke('download:detect-audio', payload),

  clearDownloadQueue: (payload) => ipcRenderer.invoke('download:clear', payload),
  clearRenderQueue: (payload) => ipcRenderer.invoke('processing:clear', payload)
});
