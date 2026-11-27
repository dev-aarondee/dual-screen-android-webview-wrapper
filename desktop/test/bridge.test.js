'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, isSerial } = require('../src/bridge');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseComPorts, serialWrite, RAW_PRINT_PS1, LIST_COM_PS1 } = require('../src/printers');

function fakeBackend(over = {}) {
  const jobs = [];
  const backend = {
    jobs,
    picks: [],
    pickAnswer: undefined,
    async listPrinters() { return [{ name: 'POS-80', displayName: 'POS-80 Receipt', isDefault: true }, { name: 'Office Laser', displayName: 'Office Laser' }]; },
    async listSerialPorts() { return [{ path: 'COM5', name: 'Standard Serial over Bluetooth link (COM5)' }]; },
    async rawPrint(name, bytes) { jobs.push(['printer', name, Buffer.from(bytes).toString()]); },
    async serialWrite(port, bytes) { jobs.push(['serial', port, Buffer.from(bytes).toString()]); },
    async pick(title, items) { backend.picks.push({ title, items }); return backend.pickAnswer === undefined ? items[0].id : backend.pickAnswer; },
    ...over,
  };
  return backend;
}

const b64 = (s) => Buffer.from(s).toString('base64');
const parse = (r) => ({ ok: r.ok, ...JSON.parse(r.json) });

test('info says it is the desktop app', async () => {
  const r = parse(await createBridge(fakeBackend(), { version: '1.2.3', platform: 'win32' }).call('info', ''));
  assert.deepEqual(r, { ok: true, usb: true, bluetooth: true, bluetoothOn: true, version: '1.2.3', platform: 'win32', desktop: true });
});

test('usb.connect with no key shows the installed printers and returns the chosen one', async () => {
  const be = fakeBackend();
  be.pickAnswer = 'POS-80';
  const r = parse(await createBridge(be).call('usb.connect', '{}'));
  assert.deepEqual(r, { ok: true, key: 'POS-80', name: 'POS-80 Receipt', opened: true });
  assert.equal(be.picks.length, 1);
  assert.deepEqual(be.picks[0].items.map((i) => i.id), ['POS-80', 'Office Laser']);
});

test('usb.connect reconnects a saved printer without asking', async () => {
  const be = fakeBackend();
  const r = parse(await createBridge(be).call('usb.connect', JSON.stringify({ key: 'POS-80', prompt: false })));
  assert.equal(r.ok, true);
  assert.equal(be.picks.length, 0);
});

test('usb.connect: a saved printer that was removed fails quietly on auto-connect', async () => {
  const be = fakeBackend();
  const r = parse(await createBridge(be).call('usb.connect', JSON.stringify({ key: 'Gone', prompt: false })));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unreachable');
  assert.equal(be.picks.length, 0);
});

test('cancelling the picker rejects with "cancelled"', async () => {
  const be = fakeBackend();
  be.pickAnswer = null;
  const r = parse(await createBridge(be).call('usb.connect', '{}'));
  assert.equal(r.code, 'cancelled');
});

test('no printers installed → no-endpoint, never advice to swap drivers', async () => {
  const be = fakeBackend({ async listPrinters() { return []; }, async listSerialPorts() { return []; } });
  for (const m of ['usb.connect', 'bt.connect']) {
    const r = parse(await createBridge(be).call(m, '{}'));
    assert.equal(r.code, 'no-endpoint');
    assert.doesNotMatch(r.message, /zadig|winusb|replace/i);
  }
});

test('usb.write sends the exact bytes to the Windows printer queue', async () => {
  const be = fakeBackend();
  const r = parse(await createBridge(be).call('usb.write', JSON.stringify({ key: 'POS-80', data: b64('\x1b@hello') })));
  assert.equal(r.ok, true);
  assert.deepEqual(be.jobs, [['printer', 'POS-80', '\x1b@hello']]);
});

test('bt.connect lists COM ports and printers; bt.write picks the right path', async () => {
  const be = fakeBackend();
  be.pickAnswer = 'COM5';
  const bridge = createBridge(be);
  const c = parse(await bridge.call('bt.connect', '{}'));
  assert.deepEqual(c, { ok: true, address: 'COM5', name: 'Standard Serial over Bluetooth link (COM5)' });
  assert.deepEqual(be.picks[0].items.map((i) => i.id), ['COM5', 'POS-80', 'Office Laser']);
  await bridge.call('bt.write', JSON.stringify({ address: 'COM5', data: b64('a') }));
  await bridge.call('bt.write', JSON.stringify({ address: 'POS-80', data: b64('b') }));
  assert.deepEqual(be.jobs, [['serial', 'COM5', 'a'], ['printer', 'POS-80', 'b']]);
});

test('writes never interleave', async () => {
  const order = [];
  const be = fakeBackend({
    async rawPrint(name, bytes) {
      const s = Buffer.from(bytes).toString();
      order.push(`start ${s}`);
      await new Promise((r) => setTimeout(r, s === '1' ? 30 : 1));
      order.push(`end ${s}`);
    },
  });
  const bridge = createBridge(be);
  await Promise.all(['1', '2'].map((s) => bridge.call('usb.write', JSON.stringify({ key: 'POS-80', data: b64(s) }))));
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('a print failure comes back as an error, and the next print still runs', async () => {
  let n = 0;
  const be = fakeBackend({ async rawPrint() { n += 1; if (n === 1) throw new Error('Printer offline'); } });
  const bridge = createBridge(be);
  const a = parse(await bridge.call('usb.write', JSON.stringify({ key: 'POS-80', data: b64('x') })));
  const b = parse(await bridge.call('usb.write', JSON.stringify({ key: 'POS-80', data: b64('y') })));
  assert.deepEqual([a.ok, a.code, a.message], [false, 'unreachable', 'Printer offline']);
  assert.equal(b.ok, true);
});

test('bad input is answered, not thrown', async () => {
  const bridge = createBridge(fakeBackend());
  assert.equal(parse(await bridge.call('usb.write', '{nope')).code, 'unreachable');
  assert.equal(parse(await bridge.call('usb.write', JSON.stringify({ key: 'POS-80', data: '' }))).ok, false);
  assert.equal(parse(await bridge.call('usb.write', JSON.stringify({ data: b64('x') }))).ok, false);
  assert.equal(parse(await bridge.call('nope', '{}')).ok, false);
  assert.equal(parse(await bridge.call('usb.close', '{}')).ok, true);
});

test('COM port parsing and serial detection', () => {
  assert.deepEqual(parseComPorts('Standard Serial over Bluetooth link (COM5)\r\nUSB Serial Device (COM3)\r\nStandard Serial over Bluetooth link (COM5)\r\n'), [
    { path: 'COM5', name: 'Standard Serial over Bluetooth link (COM5)', kind: 'bluetooth' },
    { path: 'COM3', name: 'USB Serial Device (COM3)', kind: 'serial' },
  ]);
  assert.ok(isSerial('COM12'));
  assert.ok(isSerial('/dev/cu.Printer'));
  assert.ok(!isSerial('POS-80'));
  assert.ok(!isSerial('COMPANY Printer'));
});

test('Windows printing goes through the driver queue as RAW, never replacing the driver', () => {
  assert.match(RAW_PRINT_PS1, /winspool\.drv/);
  assert.match(RAW_PRINT_PS1, /pDataType = "RAW"/);
  assert.doesNotMatch(RAW_PRINT_PS1, /pnputil|zadig|winusb/i);
});

// What a store PC showed (2026-11-27): COM1/COM2 cable ports, and a paired "GLPrinter" that Windows
// gave two Bluetooth ports. Only the outgoing one reaches the printer; the incoming one took the
// test print silently.
const GL_PC = [
  'Communications Port (COM1)\tACPI\\PNP0501\\1\t\t',
  'Communications Port (COM2)\tACPI\\PNP0501\\2\t\t',
  'Standard Serial over Bluetooth link (COM3)\tBTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0002\\7&2D5F3B1B&0&DC0D30A1B2C3_C00000000\tDC0D30A1B2C3\tGLPrinter',
  'Standard Serial over Bluetooth link (COM4)\tBTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\7&2D5F3B1B&0&000000000000_00000004\t000000000000\t',
].join('\r\n');

test('a paired Bluetooth printer shows once, by its name, and the incoming port is left out', () => {
  const ports = parseComPorts(GL_PC);
  assert.deepEqual(ports.map((p) => [p.path, p.kind, p.device]), [
    ['COM3', 'bluetooth', 'GLPrinter'],
    ['COM1', 'serial', undefined],
    ['COM2', 'serial', undefined],
  ]);
});

test('the Bluetooth picker names the printer and hides PDF, XPS, OneNote and Fax', async () => {
  const be = fakeBackend({
    async listSerialPorts() { return parseComPorts(GL_PC); },
    async listPrinters() {
      return ['OneNote for Windows 10', 'Microsoft XPS Document Writer', 'Microsoft Print to PDF', 'Fax', 'POS-58']
        .map((name) => ({ name, displayName: name }));
    },
  });
  be.pickAnswer = 'COM3';
  const c = parse(await createBridge(be).call('bt.connect', '{}'));
  assert.deepEqual(c, { ok: true, address: 'COM3', name: 'GLPrinter (COM3)' });
  const items = be.picks[0].items;
  assert.deepEqual(items.map((i) => i.id), ['COM3', 'COM1', 'COM2', 'POS-58']);
  assert.equal(items[0].detail, 'Bluetooth printer · COM3');
  assert.match(items[1].detail, /not Bluetooth/);
  const usb = fakeBackend({ async listPrinters() { return [{ name: 'Microsoft Print to PDF' }, { name: 'POS-58' }]; } });
  await createBridge(usb).call('usb.connect', '{}');
  assert.deepEqual(usb.picks[0].items.map((i) => i.id), ['POS-58']);
});

test('the COM list script tells outgoing and incoming Bluetooth ports apart', () => {
  assert.match(LIST_COM_PS1, /BTHENUM/);
  assert.match(LIST_COM_PS1, /BTHPORT\\Parameters\\Devices/);
});

test('serial write sends every byte before closing the port', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ultrapos-com-')), 'COM9');
  fs.writeFileSync(f, '');
  await serialWrite(f, Buffer.from('\x1b@receipt\n'), { settleMs: 5 });
  assert.equal(fs.readFileSync(f, 'utf8'), '\x1b@receipt\n');
  await assert.rejects(serialWrite(f + '-missing', Buffer.from('x'), { settleMs: 5 }), /Couldn't reach the printer/);
});
