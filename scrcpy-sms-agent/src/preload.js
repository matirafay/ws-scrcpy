const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smsAgent', {
    listDevices: () => ipcRenderer.invoke('list-devices'),
    getLatestSms: (options) => ipcRenderer.invoke('get-latest-sms', options),
    startScrcpy: (serial) => ipcRenderer.invoke('start-scrcpy', serial),
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    pushSms: (sms, options) => ipcRenderer.invoke('push-sms', sms, options),
});
