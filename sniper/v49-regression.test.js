'use strict';
// v49 regression: with the write-behind store, a failed POST awaited store.release(), which is
// chained behind that RFQ's slow background reserve, so send() looked like it took ~55s.
const assert = require('assert');
const { createLiveSniper } = require('./live');
const { createWriteBehindStore } = require('./write-behind');
const { createLockCoord } = require('./coord');
const S = require('../auto-sniper');

(async () => {
  const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' });
  const rfq = { rfqId: 'R1', marketTicker: 'KXMVE-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes'], contracts: 20, createdTs: Date.now() };
  const d = { rfqId: 'R1', quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8.38 };
  const released = [];
  const slowDb = { reserve: () => new Promise((r) => setTimeout(() => r({ ok: true }), 500)),
    release: async (id, ph) => { released.push([id, ph]); return true; }, update: async () => true, confirmCheck: async () => ({ ok: true }) };
  const wb = createWriteBehindStore(slowDb, { log: () => {} });
  const trader = { live: true, postQuote: async () => { const e = new Error('STALE_DROP rfq_age age=3800ms'); e.staleDrop = true; throw e; }, cancel: async () => ({}) };
  const L = createLiveSniper({ config, trader, store: wb, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.5, log: () => {} });
  const r0 = wb.reserve(d, {});
  const t0 = Date.now(); const res = await L.send(rfq, d); const ms = Date.now() - t0;
  assert.strictEqual(res.sent, false); assert.strictEqual(res.reason, 'post_stale_drop');
  assert.ok(ms < 100, `send blocked ${ms}ms behind the background reserve`);
  assert.deepStrictEqual(released, []); // DB release still waits for the reserve row (ordering kept)
  await r0.pending; await wb.flush();
  assert.deepStrictEqual(released, [['R1', 'failed']]);

  // coord.comboWorkerQuoting is bounded (hot path) and fails open like other unknowns.
  const hang = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: () => new Promise(() => {}) }) }) }) }) };
  const c = createLockCoord({ supabase: hang, log: () => {}, cwTimeoutMs: 50 });
  const t1 = Date.now(); assert.strictEqual(await c.comboWorkerQuoting('R1'), null); assert.ok(Date.now() - t1 < 200);
  assert.strictEqual(c.stats().cwTimeouts, 1);
  assert.ok(wb.backlog() === 0);
  console.log('v49 regression ok');
})().catch((e) => { console.error(e); process.exit(1); });
