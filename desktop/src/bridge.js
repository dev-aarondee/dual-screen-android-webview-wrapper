'use strict';
/**
 * The same `UltraPOSNative` protocol as the Android app (NativePrinterBridge.kt), so the
 * web app's printer code works unchanged. On a PC:
 *
 *  - "usb" printers are the printers installed in Windows (Settings → Printers). Receipts
 *    are sent as raw ESC/POS through the printer's own Windows driver, so the driver stays
 *    and every other app can still use the printer. `key` = the Windows printer name.
 *  - "bluetooth" printers are paired Bluetooth printers. Windows shows them either as a
 *    COM port ("Standard Serial over Bluetooth link (COM5)") or as an installed printer;
 *    both are offered. `address` = "COM5" or the printer name.
 *
 * Methods (all bytes are base64):
 *  - `info`                         → {usb, bluetooth, bluetoothOn, version, platform, desktop}
 *  - `usb.connect` {key?, prompt?}  → {key, name, opened}; no key = pick from a list
 *  - `usb.write`   {key, data}      → {}
 *  - `usb.close`   {key}            → {}
 *  - `bt.connect`  {address?, prompt?} → {address, name}
 *  - `bt.write`    {address, data}  → {}
 *  - `bt.close`    {address}        → {}
 *
 * Errors are {code, message} with the web app's PrinterConnectErrorCode values.
 */

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const SERIAL = /^(COM\d+|\/dev\/.+)$/i;
const isSerial = (address) => SERIAL.test(String(address || ''));

// Windows' built-in "printers" that save files or send faxes; a receipt never goes there.
const VIRTUAL = /^(microsoft print to pdf|microsoft xps document writer|onenote|send to onenote|fax)\b/i;
const isVirtualPrinter = (p) => VIRTUAL.test(String(p.displayName || p.name || '').trim());

function portOption(p) {
  if (p.kind === 'bluetooth') {
    return { id: p.path, label: p.device ? `${p.device} (${p.path})` : p.name || p.path, detail: `Bluetooth printer · ${p.path}` };
  }
  if (p.kind === 'serial') return { id: p.path, label: p.name || p.path, detail: `Cable serial port ${p.path} (not Bluetooth)` };
  return { id: p.path, label: p.name || p.path, detail: `Bluetooth / serial port ${p.path}` };
}

/**
 * backend: {
 *   listPrinters(): Promise<[{name, displayName?, isDefault?}]>,
 *   listSerialPorts(): Promise<[{path, name}]>,
 *   rawPrint(printerName, buffer): Promise<void>,
 *   serialWrite(path, buffer): Promise<void>,
 *   pick(title, items: [{id, label, detail?}]): Promise<string|null>,   // the chosen id, null = cancelled
 * }
 */
function createBridge(backend, { version = '0.0.0', platform = process.platform } = {}) {
  // One job at a time, so two receipts never interleave on one printer.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  function decode(args) {
    const data = typeof args.data === 'string' ? args.data : '';
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) throw new BridgeError('unreachable', 'Nothing to print.');
    return buf;
  }

  const printerLabel = (p) => p.displayName || p.name;

  async function usbConnect(args) {
    const printers = (await backend.listPrinters()).filter((p) => !isVirtualPrinter(p));
    const key = typeof args.key === 'string' ? args.key : '';
    if (key) {
      const found = printers.find((p) => p.name === key);
      if (found) return { key: found.name, name: printerLabel(found), opened: true };
      if (args.prompt === false) {
        throw new BridgeError('unreachable', `The printer "${key}" isn't installed on this computer any more.`);
      }
    }
    if (!printers.length) {
      throw new BridgeError('no-endpoint', 'No printers are installed on this computer. Install the receipt printer\'s Windows driver first, then try again.');
    }
    const id = await backend.pick('Choose the receipt printer', printers.map((p) => ({
      id: p.name,
      label: printerLabel(p),
      detail: p.isDefault ? 'Windows default printer' : '',
    })));
    if (!id) throw new BridgeError('cancelled', 'No printer was chosen.');
    const chosen = printers.find((p) => p.name === id);
    return { key: id, name: chosen ? printerLabel(chosen) : id, opened: true };
  }

  async function btConnect(args) {
    const [ports, printers] = await Promise.all([
      backend.listSerialPorts().catch(() => []),
      backend.listPrinters().catch(() => []),
    ]);
    const options = [
      ...ports.map(portOption),
      ...printers.filter((p) => !isVirtualPrinter(p)).map((p) => ({ id: p.name, label: printerLabel(p), detail: 'Installed printer' })),
    ];
    const address = typeof args.address === 'string' ? args.address : '';
    if (address) {
      const found = options.find((o) => o.id === address);
      if (found) return { address, name: found.label };
      if (args.prompt === false) {
        throw new BridgeError('unreachable', `The printer on ${address} isn't paired with this computer any more.`);
      }
    }
    if (!options.length) {
      throw new BridgeError('no-endpoint', 'No paired Bluetooth printer found. Pair it in Windows Settings → Bluetooth & devices first, then try again.');
    }
    const id = await backend.pick('Choose the Bluetooth printer', options);
    if (!id) throw new BridgeError('cancelled', 'No printer was chosen.');
    const chosen = options.find((o) => o.id === id);
    return { address: id, name: chosen ? chosen.label : id };
  }

  async function write(target, args) {
    if (!target) throw new BridgeError('unreachable', 'No printer chosen yet.');
    const bytes = decode(args);
    await serial(() => (isSerial(target) ? backend.serialWrite(target, bytes) : backend.rawPrint(target, bytes)));
    return {};
  }

  /** Resolves with the result object, or rejects with a BridgeError. */
  async function handle(method, args) {
    switch (method) {
      case 'info':
        return { usb: true, bluetooth: true, bluetoothOn: true, version, platform, desktop: true };
      case 'usb.connect':
        return usbConnect(args);
      case 'usb.write':
        return write(String(args.key || ''), args);
      case 'usb.close':
        return {};
      case 'bt.connect':
        return btConnect(args);
      case 'bt.write':
        return write(String(args.address || ''), args);
      case 'bt.close':
        return {};
      default:
        throw new BridgeError('unreachable', `Unknown printer method ${method}`);
    }
  }

  /** Never throws: returns {ok, json} ready for window.__ultraposNative.resolve. */
  async function call(method, argsJson) {
    let args = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
      if (!args || typeof args !== 'object') args = {};
    } catch (e) {
      return { ok: false, json: JSON.stringify({ code: 'unreachable', message: `Bad arguments: ${e.message}` }) };
    }
    try {
      const result = await handle(String(method), args);
      return { ok: true, json: JSON.stringify(result || {}) };
    } catch (e) {
      const code = e instanceof BridgeError ? e.code : 'unreachable';
      return { ok: false, json: JSON.stringify({ code, message: String((e && e.message) || e) }) };
    }
  }

  return { call, handle };
}

module.exports = { createBridge, BridgeError, isSerial };
