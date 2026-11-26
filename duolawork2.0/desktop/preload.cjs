const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duolaworkDesktop', {
  isDesktop: true,
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('dw2:choose-directory', defaultPath),
  setTheme: (theme) => ipcRenderer.invoke('dw2:set-theme', theme)
});
