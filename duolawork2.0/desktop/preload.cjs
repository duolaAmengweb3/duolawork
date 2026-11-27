const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duolaworkDesktop', {
  isDesktop: true,
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('dw2:choose-directory', defaultPath),
  setTheme: (theme) => ipcRenderer.invoke('dw2:set-theme', theme),
  openPopoutWindow: (opts) => ipcRenderer.invoke('dw2:open-popout', opts),
  setAlwaysOnTop: (alwaysOnTop) => ipcRenderer.invoke('dw2:set-always-on-top', Boolean(alwaysOnTop)),
  onReaderOpenTab: (callback) => {
    const handler = (_event, payload) => {
      if (typeof callback === 'function') callback(payload);
    };
    ipcRenderer.on('dw2:reader-open-tab', handler);
    return () => ipcRenderer.removeListener('dw2:reader-open-tab', handler);
  }
});
