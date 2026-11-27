'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { secondScreenUrlFor, normalizeUrl, sameOrigin } = require('../src/urls');
const { clean, DEFAULTS, createStore } = require('../src/settings');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('second screen follows the cashier store, same as the Android app', () => {
  assert.equal(secondScreenUrlFor('https://system.caltiger.ai/store/abc/pos?x=1'), 'https://system.caltiger.ai/store/abc/second-screen');
  assert.equal(secondScreenUrlFor('http://192.168.1.20:5173/store/x-1/settings#y'), 'http://192.168.1.20:5173/store/x-1/second-screen');
  assert.equal(secondScreenUrlFor('https://system.caltiger.ai/'), null);
  assert.equal(secondScreenUrlFor('https://system.caltiger.ai/login'), null);
  assert.equal(secondScreenUrlFor('file:///C:/offline.html'), null);
});

test('normalizeUrl adds the right scheme', () => {
  assert.equal(normalizeUrl('system.caltiger.ai'), 'https://system.caltiger.ai');
  assert.equal(normalizeUrl(' localhost:5173 '), 'http://localhost:5173');
  assert.equal(normalizeUrl('192.168.1.20:5173/store/a'), 'http://192.168.1.20:5173/store/a');
  assert.equal(normalizeUrl('pos.local'), 'http://pos.local');
  assert.equal(normalizeUrl('https://x.y'), 'https://x.y');
  assert.equal(normalizeUrl(''), '');
});

test('the printer bridge only serves the cashier origin', () => {
  assert.ok(sameOrigin('https://system.caltiger.ai/store/a/pos', 'https://system.caltiger.ai'));
  assert.ok(!sameOrigin('https://evil.example/store/a', 'https://system.caltiger.ai'));
  assert.ok(!sameOrigin('http://system.caltiger.ai/', 'https://system.caltiger.ai'));
  assert.ok(!sameOrigin('file:///C:/offline.html', 'https://system.caltiger.ai'));
  assert.ok(!sameOrigin('about:blank', 'https://system.caltiger.ai'));
  assert.ok(!sameOrigin('', 'https://system.caltiger.ai'));
});

test('settings fill defaults and survive junk', () => {
  assert.deepEqual(clean(null), { ...DEFAULTS });
  assert.deepEqual(clean({ main_url: 'pos.example.com', customer_url: ' ', fullscreen: 'yes' }), {
    main_url: 'https://pos.example.com', customer_url: '', start_with_windows: true, fullscreen: true,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrapos-test-'));
  const store = createStore(dir);
  assert.equal(store.load().main_url, DEFAULTS.main_url);
  store.save({ customer_url: 'localhost:5173/display', fullscreen: false });
  const again = createStore(dir).load();
  assert.equal(again.customer_url, 'http://localhost:5173/display');
  assert.equal(again.fullscreen, false);
  fs.writeFileSync(store.file, '{not json');
  assert.equal(createStore(dir).load().main_url, DEFAULTS.main_url);
});
