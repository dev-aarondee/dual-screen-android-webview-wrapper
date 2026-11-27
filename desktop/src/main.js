'use strict';
/**
 * Ultra POS for Windows: the PC twin of the Android app.
 *
 * - The cashier window shows main_url on the main monitor.
 * - The customer window shows customer_url full screen on the second monitor. When
 *   customer_url is blank, it follows the cashier: once the cashier is on /store/<id>/…,
 *   it shows /store/<id>/second-screen. Both windows share one browser profile, so the
 *   same-origin localStorage / BroadcastChannel the web app uses to feed the customer
 *   screen just works.
 * - The cashier window gets `window.UltraPOSNative` (see bridge.js) so receipts print
 *   through the printer's own Windows driver.
 * - With no internet on the first start (nothing saved yet), a "Please connect to the
 *   internet" page shows and opens the POS by itself when the connection is back. After
 *   one load, the web app's own offline copy opens without internet.
 * - Tap the top-left corner 5 times (or press Ctrl+Shift+U) for the Screen URLs settings.
 */
const { app, BrowserWindow, screen, ipcMain, shell, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const { createStore } = require('./settings');
const { secondScreenUrlFor, sameOrigin } = require('./urls');
const { createBridge } = require('./bridge');
const { createBackend } = require('./printers');

if (process.env.ULTRAPOS_USER_DATA) app.setPath('userData', process.env.ULTRAPOS_USER_DATA);
// Order sounds and the customer screen's videos play without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const PAGES = path.join(__dirname, 'pages');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const BLANK = 'data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:#000"></body></html>');

let store;
let bridge;
let cashier = null;
let customer = null;
let customerDisplayId = null;
let settingsWin = null;
let picker = null;
let autoCustomerUrl = null;

// ------------------------------------------------------------------ helpers

const settings = () => store.load();
const effectiveCustomerUrl = () => settings().customer_url || autoCustomerUrl || '';
const alive = (w) => w && !w.isDestroyed();

// Test runs on a one-monitor computer: show the customer screen as a small window.
const TEST_CUSTOMER_WINDOW = process.env.ULTRAPOS_TEST_CUSTOMER_WINDOW === '1';

function customerDisplay() {
  const primary = screen.getPrimaryDisplay();
  const second = screen.getAllDisplays().find((d) => d.id !== primary.id);
  if (second) return second;
  if (TEST_CUSTOMER_WINDOW) return { id: -1, bounds: { x: primary.bounds.x + 40, y: primary.bounds.y + 40, width: 480, height: 800 } };
  return null;
}

function applyStartup() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: settings().start_with_windows });
}

/** First start with no internet (nothing saved yet): say so, and retry by itself. */
function attachOfflineFallback(win, mode) {
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 = aborted (a newer navigation took over), not a failure.
    if (!isMainFrame || code === -3 || !/^https?:/i.test(url)) return;
    win.loadFile(path.join(PAGES, 'offline.html'), { query: { url, mode, reason: desc } });
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && alive(win)) win.webContents.reload();
  });
}

function guardNavigation(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|about:blank)/i.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON } };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    // tel:, mailto: and the like go to the matching Windows app.
    if (!/^(https?:|file:|about:|data:|blob:)/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
}

// ------------------------------------------------------------------ cashier

function createCashier() {
  const s = settings();
  const d = screen.getPrimaryDisplay();
  cashier = new BrowserWindow({
    x: d.workArea.x,
    y: d.workArea.y,
    width: d.workArea.width,
    height: d.workArea.height,
    fullscreen: s.fullscreen,
    title: 'Ultra POS',
    icon: ICON,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-cashier.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  cashier.once('ready-to-show', () => {
    if (!settings().fullscreen) cashier.maximize();
    cashier.show();
  });
  cashier.on('closed', () => {
    cashier = null;
    app.quit();
  });

  const wc = cashier.webContents;
  guardNavigation(wc);
  attachOfflineFallback(cashier, 'cashier');
  wc.on('did-navigate', (_e, url) => onCashierUrlChanged(url));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) onCashierUrlChanged(url); });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key).toLowerCase();
    const ctrl = input.control || input.meta;
    if (ctrl && input.shift && key === 'u') { e.preventDefault(); openSettings(); }
    else if (key === 'f11') { e.preventDefault(); cashier.setFullScreen(!cashier.isFullScreen()); }
    else if (key === 'f5' || (ctrl && !input.shift && key === 'r')) { e.preventDefault(); wc.reload(); }
    else if (ctrl && input.shift && key === 'i') { e.preventDefault(); wc.toggleDevTools(); }
  });

  cashier.loadURL(s.main_url);
}

/** With customer_url blank, the customer screen follows the cashier's store. */
function onCashierUrlChanged(url) {
  const derived = secondScreenUrlFor(url);
  if (!derived || derived === autoCustomerUrl) return;
  autoCustomerUrl = derived;
  if (!settings().customer_url) loadCustomer(derived);
}

// ------------------------------------------------------------------ customer display

function loadCustomer(url) {
  if (!alive(customer)) return;
  customer.loadURL(url || BLANK);
}

function refreshCustomer() {
  const d = customerDisplay();
  if (!d) {
    if (alive(customer)) customer.destroy();
    customer = null;
    customerDisplayId = null;
    return;
  }
  const full = d.id !== -1;
  if (alive(customer) && customerDisplayId === d.id) {
    if (full && !customer.isFullScreen()) {
      customer.setBounds(d.bounds);
      customer.setFullScreen(true);
    }
    return;
  }
  if (alive(customer)) customer.destroy();

  const win = new BrowserWindow({
    ...d.bounds,
    frame: !full,
    fullscreen: full,
    skipTaskbar: true,
    title: 'Ultra POS customer display',
    icon: ICON,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  customer = win;
  customerDisplayId = d.id;
  win.once('ready-to-show', () => {
    win.setBounds(d.bounds);
    if (full) win.setFullScreen(true);
    win.showInactive();
    if (alive(cashier)) cashier.focus();
  });
  win.on('closed', () => {
    if (customer === win) {
      customer = null;
      customerDisplayId = null;
    }
  });
  guardNavigation(win.webContents);
  attachOfflineFallback(win, 'customer');
  loadCustomer(effectiveCustomerUrl());
}

let displayTimer = null;
function onDisplaysChanged() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(refreshCustomer, 600);
}

function reloadBothScreens() {
  if (alive(cashier)) cashier.loadURL(settings().main_url);
  if (alive(customer)) loadCustomer(effectiveCustomerUrl());
  else refreshCustomer();
}

// ------------------------------------------------------------------ settings window

function openSettings() {
  if (alive(settingsWin)) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    parent: alive(cashier) ? cashier : undefined,
    modal: alive(cashier),
    width: 560,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Screen URLs',
    icon: ICON,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-dialog.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.loadFile(path.join(PAGES, 'settings.html'));
}

const fromSettings = (e) => alive(settingsWin) && e.sender === settingsWin.webContents;

ipcMain.on('open-settings', (e) => { if (alive(cashier) && e.sender === cashier.webContents) openSettings(); });
ipcMain.handle('settings:get', (e) => {
  if (!fromSettings(e)) return null;
  return { ...settings(), effectiveCustomerUrl: effectiveCustomerUrl(), customerDisplays: customerDisplay() ? 1 : 0 };
});
ipcMain.handle('settings:save', (e, patch) => {
  if (!fromSettings(e) || !patch || typeof patch !== 'object') return false;
  const before = settings();
  const s = store.save({
    main_url: String(patch.main_url ?? ''),
    customer_url: String(patch.customer_url ?? ''),
    start_with_windows: !!patch.start_with_windows,
    fullscreen: !!patch.fullscreen,
  });
  if (s.main_url !== before.main_url) autoCustomerUrl = null;
  applyStartup();
  if (alive(cashier)) cashier.setFullScreen(s.fullscreen);
  reloadBothScreens();
  return true;
});
ipcMain.handle('settings:reload', (e) => { if (fromSettings(e)) reloadBothScreens(); return true; });
ipcMain.handle('settings:quit', (e) => { if (fromSettings(e)) app.quit(); return true; });

// ------------------------------------------------------------------ printer picker

function pick(title, items) {
  return new Promise((resolve) => {
    if (picker) {
      picker.resolve(null);
      if (alive(picker.win)) picker.win.destroy();
    }
    const win = new BrowserWindow({
      parent: alive(cashier) ? cashier : undefined,
      modal: alive(cashier),
      width: 480,
      height: Math.min(600, 190 + items.length * 70),
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title,
      icon: ICON,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-dialog.js'), contextIsolation: true, sandbox: true },
    });
    const state = { title, items, resolve, win };
    picker = state;
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      state.resolve(null);
      if (picker === state) picker = null;
    });
    win.loadFile(path.join(PAGES, 'picker.html'));
  });
}

const fromPicker = (e) => picker && alive(picker.win) && e.sender === picker.win.webContents;
ipcMain.handle('picker:get', (e) => (fromPicker(e) ? { title: picker.title, items: picker.items } : { title: '', items: [] }));
ipcMain.handle('picker:done', (e, id) => {
  if (!fromPicker(e)) return false;
  const state = picker;
  picker = null;
  state.resolve(typeof id === 'string' ? id : null);
  return true;
});

// ------------------------------------------------------------------ printing bridge

ipcMain.on('native-call', async (e, id, method, argsJson) => {
  const wc = e.sender;
  if (!alive(cashier) || wc !== cashier.webContents) return;
  const frameUrl = (e.senderFrame && e.senderFrame.url) || wc.getURL();
  const reply = sameOrigin(frameUrl, settings().main_url)
    ? await bridge.call(method, argsJson)
    : { ok: false, json: JSON.stringify({ code: 'denied', message: 'Printing is only available to the cashier site.' }) };
  if (wc.isDestroyed()) return;
  const js = `window.__ultraposNative&&window.__ultraposNative.resolve(${JSON.stringify(String(id))},${reply.ok ? 'true' : 'false'},${JSON.stringify(reply.json)})`;
  wc.executeJavaScript(js, true).catch(() => {});
});

// ------------------------------------------------------------------ start

function start() {
  store = createStore(app.getPath('userData'));
  bridge = createBridge(
    createBackend({
      getPrinters: () => (alive(cashier) ? cashier.webContents.getPrintersAsync() : Promise.resolve([])),
      pick,
    }),
    { version: app.getVersion() },
  );
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  powerSaveBlocker.start('prevent-display-sleep');
  applyStartup();
  createCashier();
  refreshCustomer();
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!alive(cashier)) return;
    if (cashier.isMinimized()) cashier.restore();
    cashier.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
