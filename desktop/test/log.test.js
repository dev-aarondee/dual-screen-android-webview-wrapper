'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLog, MAX_BYTES } = require('../src/log');

test('writes one line per entry, newlines flattened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrapos-log-'));
  const log = createLog(dir);
  log.info('started 1.0.1');
  log.error('print failed:\nCan\'t open printer');
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.* INFO started 1\.0\.1$/);
  assert.match(lines[1], /ERROR print failed: Can't open printer$/);
});

test('rolls over to ultrapos.old.log past the size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrapos-log-'));
  const log = createLog(dir);
  fs.writeFileSync(log.file, 'x'.repeat(MAX_BYTES + 1));
  log.info('after');
  assert.ok(fs.existsSync(path.join(dir, 'ultrapos.old.log')));
  assert.match(fs.readFileSync(log.file, 'utf8'), /INFO after/);
});

test('never throws when the folder cannot be written', () => {
  const log = createLog('/dev/null/not-a-dir');
  assert.doesNotThrow(() => log.error('x'));
});
