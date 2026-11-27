'use strict';
// Runs on the Windows CI build: compiles the real winspool script and lists COM ports,
// so a broken script never ships. (No printer on CI, so the print must fail cleanly.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('../src/printers');

const onWindows = process.platform === 'win32';

test('raw print to a missing Windows printer fails with a clear message', { skip: !onWindows }, async () => {
  const be = createBackend({ getPrinters: async () => [], pick: async () => null });
  await assert.rejects(be.rawPrint('Ultra POS No Such Printer', Buffer.from('\x1b@test\n')), /Couldn't print to "Ultra POS No Such Printer": .*Can't open printer/);
});

test('listing COM ports works on Windows', { skip: !onWindows }, async () => {
  const be = createBackend({ getPrinters: async () => [], pick: async () => null });
  const ports = await be.listSerialPorts();
  assert.ok(Array.isArray(ports));
  for (const p of ports) {
    assert.match(p.path, /^COM\d+$/);
    assert.ok(['bluetooth', 'serial'].includes(p.kind), JSON.stringify(p));
  }
});
