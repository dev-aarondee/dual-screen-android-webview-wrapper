'use strict';
// For the app's own small windows (settings, printer picker). Never loaded into
// a website.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['settings:get', 'settings:save', 'settings:reload', 'settings:quit', 'settings:logs', 'picker:get', 'picker:done']);

contextBridge.exposeInMainWorld('ultrapos', {
  invoke(channel, ...args) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
});
