'use strict';
const assert = require('node:assert');
const { createStaleAlert } = require('./stale-alert');
let t = 0; const msgs = [];
const a = createStaleAlert({ now: () => t, alert: (m) => msgs.push(m) });
for (let i = 0; i < 100; i++) { t = i * 6000; a.record(i % 4 === 0); } // 25% stale over 10 min
assert.strictEqual(msgs.length, 0);
for (let i = 100; i < 200; i++) { t = i * 6000; a.record(true); }
assert.strictEqual(msgs.length, 1); assert.match(msgs[0], /prices_stale/);
for (let i = 200; i < 230; i++) { t = i * 6000; a.record(true); }
assert.strictEqual(msgs.length, 1, 'one alert per episode');
for (let i = 230; i < 400; i++) { t = i * 6000; a.record(false); }
assert.strictEqual(msgs.length, 2); assert.match(msgs[1], /recovered/);
// fetch timeout helper
const { fetchWithTimeout } = require('./fetch-timeout');
(async () => {
  const hang = (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason)));
  const t0 = Date.now();
  await assert.rejects(fetchWithTimeout(hang, 'x', {}, 50), /timeout/i);
  assert.ok(Date.now() - t0 < 1000);
  const ok = await fetchWithTimeout(async () => ({ ok: true }), 'x', {}, 50); assert.ok(ok.ok);
  console.log('stale-alert.test.js ok');
})();
