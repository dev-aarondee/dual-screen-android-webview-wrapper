'use strict';
// Cashier window only. Gives the web app the same `window.UltraPOSNative` the
// Android app injects; answers come back from the main process as
// window.__ultraposNative.resolve(id, ok, json). The main process only accepts
// calls from pages on the cashier URL's origin.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('UltraPOSNative', {
  // Read synchronously by the web app (src/lib/terminalApp.ts) so its help
  // gives Windows steps here, not the Android app's.
  desktop: true,
  platform: process.platform,
  call(id, method, argsJson) {
    ipcRenderer.send('native-call', String(id), String(method), argsJson == null ? '' : String(argsJson));
  },
});

// Tap (or click) the top-left corner 5 times within 3 seconds to open the
// Screen URLs settings, like the Android app. Taps still reach the page.
const HOTSPOT_PX = 80;
const TAPS = 5;
const WINDOW_MS = 3000;
let count = 0;
let firstAt = 0;
window.addEventListener('pointerdown', (e) => {
  if (e.clientX <= HOTSPOT_PX && e.clientY <= HOTSPOT_PX) {
    const now = Date.now();
    if (now - firstAt > WINDOW_MS) {
      firstAt = now;
      count = 0;
    }
    count += 1;
    if (count >= TAPS) {
      count = 0;
      firstAt = 0;
      ipcRenderer.send('open-settings');
    }
  } else {
    count = 0;
  }
}, true);
