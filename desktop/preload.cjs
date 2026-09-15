const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('desktopSetup', {
  save: (fields) => ipcRenderer.invoke('setup:save', fields),
});
