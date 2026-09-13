const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('whatsappLinuxSettings', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-settings', settings)
});
