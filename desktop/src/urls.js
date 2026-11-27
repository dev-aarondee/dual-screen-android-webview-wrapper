'use strict';
// Same rules as the Android app (MainActivity.kt companion object).

const DEFAULT_MAIN_URL = 'https://system.caltiger.ai';
const DEFAULT_CUSTOMER_URL = ''; // blank = follow the cashier's store

const STORE_PATH = /^(https?:\/\/[^/?#]+)\/store\/([^/?#]+)/;

/**
 * "https://system.caltiger.ai/store/abc/pos?x=1" → "https://system.caltiger.ai/store/abc/second-screen".
 * Null when the cashier isn't inside a store yet (sign-in page, store picker).
 */
function secondScreenUrlFor(url) {
  const m = STORE_PATH.exec(String(url || ''));
  return m ? `${m[1]}/store/${m[2]}/second-screen` : null;
}

/**
 * Adds a scheme when someone pastes a bare host: https:// for "system.caltiger.ai",
 * http:// for local dev hosts like "192.168.1.20:5173" or "localhost:5173".
 */
function normalizeUrl(raw) {
  const url = String(raw || '').trim();
  if (!url || url.includes('://') || url.startsWith('about:') || url.startsWith('data:')) return url;
  const host = url.split('/')[0].split(':')[0];
  const isLocal = host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.endsWith('.local');
  return (isLocal ? 'http://' : 'https://') + url;
}

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Printing is only for pages on the cashier URL's own origin. */
function sameOrigin(a, b) {
  const oa = originOf(a);
  return oa !== null && oa === originOf(b);
}

module.exports = { DEFAULT_MAIN_URL, DEFAULT_CUSTOMER_URL, secondScreenUrlFor, normalizeUrl, sameOrigin, originOf };
