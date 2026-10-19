// POLY_DRY_RUN guard, preloaded with `node -r ./dry-run-guard.js` by start-poly.js.
// Belt and braces on top of POLYMARKET_RFQ_LIVE=0: every non-GET/HEAD HTTP call made
// through global fetch (Supabase, Telegram, ...) or undici (Polymarket REST) is
// answered locally and never leaves the process. So the dry-run service places no
// orders, cancels nothing, sends no alerts and writes nothing to the database.
'use strict';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const counts = new Map();
function note(kind, method, url) {
  let path = String(url || '');
  try { const u = new URL(path); path = `${u.host}${u.pathname}`; } catch (_) {}
  path = path.replace(/[0-9a-f-]{20,}/gi, ':id');
  const k = `${kind} ${method} ${path}`;
  const n = (counts.get(k) || 0) + 1;
  counts.set(k, n);
  if (n <= 3 || n % 500 === 0) console.log(`[POLY-DRY] blocked ${k} n=${n}`);
}
const realFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init = {}) {
  const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  if (SAFE.has(method)) return realFetch(input, init);
  note('fetch', method, typeof input === 'string' ? input : (input && input.url));
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const undici = require('undici');
  const { Readable } = require('stream');
  for (const C of [undici.Pool, undici.Client, undici.Agent, undici.Dispatcher].filter(Boolean)) {
    const orig = C.prototype.request;
    if (!orig || orig.__dryGuard) continue;
    const wrapped = function (opts, ...rest) {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      if (SAFE.has(method)) return orig.call(this, opts, ...rest);
      note('undici', method, opts && opts.path);
      const res = { statusCode: 403, headers: {}, body: Object.assign(Readable.from(['{"error":"POLY_DRY_RUN"}']), { json: async () => ({ error: 'POLY_DRY_RUN' }), text: async () => '{"error":"POLY_DRY_RUN"}' }) };
      return Promise.resolve(res);
    };
    wrapped.__dryGuard = true;
    C.prototype.request = wrapped;
  }
} catch (_) {}
module.exports = { counts };
