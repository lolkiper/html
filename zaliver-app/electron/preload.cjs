const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zaliver", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  platform: process.platform,
});
