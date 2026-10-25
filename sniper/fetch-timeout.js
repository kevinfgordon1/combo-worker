// fetch() with a hard deadline. Node's default fetch can wait ~5 min on a hung socket, which
// froze the sniper's Kalshi book loop (Oct 24 2026: prices_stale on every RFQ for hours).
'use strict';
function fetchWithTimeout(fetchImpl, url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms);
  return Promise.resolve(fetchImpl(url, { ...opts, signal: ac.signal })).finally(() => clearTimeout(timer));
}
module.exports = { fetchWithTimeout };
