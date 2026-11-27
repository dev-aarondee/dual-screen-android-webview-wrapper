'use strict';
// A small text log on the PC (%APPDATA%\Ultra POS\logs\ultrapos.log) so a store's
// problem can be read afterwards: failed loads, page crashes, print errors, app
// errors. No receipt contents and nothing typed by staff are written. Kept under
// ~1 MB: the old file is moved to ultrapos.old.log once, then overwritten.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;

function createLog(dir) {
  const file = path.join(dir, 'ultrapos.log');
  const old = path.join(dir, 'ultrapos.old.log');
  function write(level, msg) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, old);
      } catch (_) { /* no file yet */ }
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${String(msg).replace(/\s+/g, ' ').slice(0, 2000)}\n`);
    } catch (_) { /* logging must never break the app */ }
  }
  return { file, dir, info: (m) => write('INFO', m), error: (m) => write('ERROR', m) };
}

module.exports = { createLog, MAX_BYTES };
