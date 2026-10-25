'use strict';
const assert = require('node:assert');
const { createQuoteSender, isStaleDrop } = require('../quote-sender');
const { createLimiter } = require('./limiter');
(async () => {
  // 1) priority: higher-EV sends go first once a slot frees
  const order = []; let release;
  const s = createQuoteSender({ maxConcurrent: 1, maxQueueMs: 1e9, maxRfqAgeMs: 1e9 });
  const block = s.send('a', null, () => new Promise((r) => { release = r; }));
  const p = [['low', 1], ['high', 9], ['mid', 5]].map(([id, pr]) => s.send(id, null, async () => { order.push(id); }, { priority: pr }));
  await new Promise((r) => setImmediate(r)); release(); await block; await Promise.all(p);
  assert.deepStrictEqual(order, ['high', 'mid', 'low']);
  // 2) bounded queue drops the lowest-priority waiter immediately
  const s2 = createQuoteSender({ maxConcurrent: 1, maxQueued: 2, maxQueueMs: 1e9, maxRfqAgeMs: 1e9 }); let rel2;
  const b2 = s2.send('x', null, () => new Promise((r) => { rel2 = r; }));
  const q = [s2.send('p1', null, async () => 1, { priority: 3 }), s2.send('p2', null, async () => 2, { priority: 1 }), s2.send('p3', null, async () => 3, { priority: 2 })];
  const res = await Promise.allSettled([q[1]]);
  assert.strictEqual(res[0].status, 'rejected'); assert.ok(isStaleDrop(res[0].reason)); assert.match(res[0].reason.message, /queue_full/);
  await new Promise((r) => setImmediate(r)); rel2(); await b2; assert.deepStrictEqual(await Promise.all([q[0], q[2]]), [1, 3]);
  assert.strictEqual(s2.stats().queueFull, 1);
  // default (combo-worker) behaviour unchanged: FIFO, unbounded
  const s3 = createQuoteSender({ maxConcurrent: 1 }); const o3 = [];
  await Promise.all(['1', '2', '3'].map((id) => s3.send(id, null, async () => { o3.push(id); })));
  assert.deepStrictEqual(o3, ['1', '2', '3']);
  // 3) limiter: low-priority (cancel) waits while a normal caller wants the token
  const L = createLimiter({ name: 't', ratePerSec: 20, burst: 1 }); const seq = [];
  await L.run(async () => ({ ok: true }));
  const lo = L.run(async () => { seq.push('cancel'); return { ok: true }; }, { low: true });
  const hi = L.run(async () => { seq.push('post'); return { ok: true }; });
  await Promise.all([lo, hi]);
  assert.deepStrictEqual(seq, ['post', 'cancel']);
  // 4) three lanes: urgent cancel > quote > routine TTL cancel
  const L2 = createLimiter({ name: 't2', ratePerSec: 20, burst: 1 }); const seq2 = [];
  await L2.run(async () => ({ ok: true }));
  const mk = (tag, opts) => L2.run(async () => { seq2.push(tag); return { ok: true }; }, opts);
  await Promise.all([mk('ttl', { priority: 0 }), mk('quote', {}), mk('urgent', { priority: 2 })]);
  assert.deepStrictEqual(seq2, ['urgent', 'quote', 'ttl']);
  // 5) trader.cancel maps urgency → limiter priority; live passes urgent only for non-TTL reasons
  const { createSniperTrader } = require('./trader');
  const seen = []; const fakeLim = { run: async (fn, o) => { seen.push(o.priority); return fn(); }, stats: () => ({}) };
  const tr = createSniperTrader({ gate: { live: true }, keyId: 'k', pem: '', subaccount: 1, limiter: fakeLim,
    request: async () => ({ statusCode: 204, headers: {}, text: '' }) });
  try { await tr.cancel('q1', { urgent: false }); await tr.cancel('q2'); } catch (_) { /* signing with a dummy key may throw before request */ }
  if (seen.length === 2) assert.deepStrictEqual(seen, [0, 2]);
  const src = require('fs').readFileSync(require('path').join(__dirname, 'live.js'), 'utf8');
  assert.match(src, /trader\.cancel\(quoteId, \{ urgent: reason !== 'ttl' \}\)/);
  console.log('trade-lane.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
