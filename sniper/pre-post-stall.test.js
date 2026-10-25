'use strict';
// v50 rollout: with write-behind on, sends are no longer serialized behind the blocking reserve,
// so every quote fires its own combo_submissions query at once. Modelled here as a client with 4
// connections x 100ms: 120 concurrent sends wait up to ~3s before the POST (pre=~3000ms in prod),
// then quote-sender drops them on rfq_age. Poll mode makes the check a Set lookup (no per-send I/O).
const assert = require('assert');
const { createLiveSniper } = require('./live');
const { createLockCoord } = require('./coord');
const S = require('../auto-sniper');

function pooledSupabase(conns, ms, live = []) {
  let busy = 0; const waiters = [];
  const slot = () => (busy < conns ? (busy += 1, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const free = () => { const w = waiters.shift(); if (w) w(); else busy -= 1; };
  const q = (rows) => ({ eq() { return this; }, limit: async () => { await slot(); await new Promise((r) => setTimeout(r, ms)); free(); return { data: rows, error: null }; } });
  return { from: () => ({ select: (cols) => q(cols === 'rfq_id' ? live.map((id) => ({ rfq_id: id })) : []) }) };
}

(async () => {
  const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' });
  async function run(coord) {
    const pres = [];
    const trader = { live: true, postQuote: async () => ({ quoteId: `Q${Math.random()}`, noBid: '0.4', yesBid: '0' }), cancel: async () => ({}) };
    const store = { release: async () => true, update: async () => true };
    const L = createLiveSniper({ config, trader, store, coord, caps: () => ({}), reprice: () => 0.5, log: () => {}, ttlMs: 60000 });
    await Promise.all(Array.from({ length: 120 }, (_, i) => {
      const rfq = { rfqId: `R${i}`, marketTicker: 'KXMVE-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes'], contracts: 20, createdTs: Date.now() };
      const t = Date.now();
      return L.send(rfq, { rfqId: rfq.rfqId, quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8 }).then(() => pres.push(Date.now() - t));
    }));
    await L.shutdown().catch(() => {});
    return pres.sort((a, b) => a - b);
  }
  const q = createLockCoord({ supabase: pooledSupabase(4, 100), log: () => {}, cwMode: 'query', cwTimeoutMs: 10000 });
  const slow = await run(q);
  assert.ok(slow[slow.length - 1] >= 2500, `expected ~3s stall, got ${slow[slow.length - 1]}ms`);

  const p = createLockCoord({ supabase: pooledSupabase(4, 100, ['R7']), log: () => {}, cwMode: 'poll' });
  await p.pollSubs();
  assert.strictEqual(await p.comboWorkerQuoting('R7'), 'combo_worker_quoting');
  assert.strictEqual(await p.comboWorkerQuoting('R8'), null);
  const fast = await run(p);
  assert.ok(fast[fast.length - 1] < 200, `poll mode still stalls ${fast[fast.length - 1]}ms`);
  console.log(`pre-post stall ok: query max=${slow[slow.length - 1]}ms poll max=${fast[fast.length - 1]}ms`);
})().catch((e) => { console.error(e); process.exit(1); });
