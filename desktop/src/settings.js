'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULT_MAIN_URL, DEFAULT_CUSTOMER_URL, normalizeUrl } = require('./urls');

const DEFAULTS = Object.freeze({
  main_url: DEFAULT_MAIN_URL,
  customer_url: DEFAULT_CUSTOMER_URL,
  start_with_windows: true,
  fullscreen: true,
});

/** Fills gaps and drops junk so a hand-edited or old settings.json still works. */
function clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    main_url: normalizeUrl(s.main_url) || DEFAULTS.main_url,
    customer_url: normalizeUrl(s.customer_url ?? DEFAULTS.customer_url),
    start_with_windows: typeof s.start_with_windows === 'boolean' ? s.start_with_windows : DEFAULTS.start_with_windows,
    fullscreen: typeof s.fullscreen === 'boolean' ? s.fullscreen : DEFAULTS.fullscreen,
  };
}

function createStore(dir) {
  const file = path.join(dir, 'settings.json');
  let current = null;
  function load() {
    if (current) return current;
    try {
      current = clean(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      current = clean({});
    }
    return current;
  }
  function save(patch) {
    current = clean({ ...load(), ...patch });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2));
    return current;
  }
  return { load, save, file };
}

module.exports = { DEFAULTS, clean, createStore };
