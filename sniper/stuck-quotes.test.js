'use strict';
// Oct 26 2026 stuck-quote fix: TTL release decoupled from cancel, low-lane guaranteed share,
// stale sweep, stale row no longer blocks a fresh quote on the same combo.
const assert = require('assert');
const { createLiveSniper } = require('./live');
const { createLimiter } = require('./limiter');
const { sweepStaleQuotes } = require('./stale-sweep');
const { createBatchedLedgerStore } = require('./ledger-batch');
const S = require('../auto-sniper');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. TTL: row released even while the routine cancel never gets a token.
  { const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' });
    const rfq = { rfqId: 'R1', marketTicker: 'KXMVE-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes'], contracts: 20, createdTs: Date.now() };
    const d = { rfqId: 'R1', quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8.38 };
    const ops = []; let cancels = 0;
    const trader = { live: true, postQuote: async () => ({ quoteId: 'Q1', noBid: '0.419', yesBid: '0.00' }), cancel: () => { cancels += 1; return new Promise(() => {}); } };
    const store = { release: async (id, ph) => ops.push(['release', id, ph]), update: async () => true };
    const L = createLiveSniper({ config, trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.5, log: () => {}, ttlMs: 20, startedReason: () => null });
    await L.send(rfq, d); await wait(60);
    assert.deepStrictEqual(ops, [['release', 'R1', 'cancelled']]); assert.strictEqual(cancels, 1);
    assert.strictEqual(L.pending.size, 0); assert.ok(L.hasRfqId('R1'), 'background cancel still tracked'); }

  // 2. Limiter: low lane gets ~lowShareRps under a constant normal-lane queue; urgent still first.
  { const lim = createLimiter({ name: 't', ratePerSec: 20, burst: 1, lowShareRps: 5 });
    let stop = false; const order = [];
    const flood = async () => { while (!stop) await lim.run(async () => { order.push('n'); return { ok: true }; }); };
    const f = [flood(), flood(), flood()];
    const t0 = Date.now(); await lim.run(async () => { order.push('low'); return { ok: true }; }, { priority: 0 });
    const lowMs = Date.now() - t0;
    stop = true; await Promise.all(f);
    assert.ok(lowMs < 3000, `low lane starved ${lowMs}ms`);
    const off = createLimiter({ name: 't2', ratePerSec: 20, burst: 1 }); let s2 = false;
    const fl2 = async () => { while (!s2) await off.run(async () => ({ ok: true })); };
    const g = [fl2(), fl2()]; let done = false; off.run(async () => ({ ok: true }), { priority: 0 }).then(() => { done = true; });
    await wait(400); assert.strictEqual(done, false, 'share=0 keeps old strict priority'); s2 = true; await Promise.all(g); await wait(50); }

  // 3. Sweep: releases untracked stale rows, skips tracked/filled, cancel failure still releases.
  { const rows = [{ rfq_id: 'a', quote_id: 'qa', risk: 10 }, { rfq_id: 'b', quote_id: 'qb', risk: 20 }, { rfq_id: 'c', quote_id: null, risk: 5 }, { rfq_id: 'd', quote_id: 'qd', risk: 7, filled_contracts: 3 }];
    const rel = []; const trader = { live: true, cancel: async (q) => { if (q === 'qa') throw new Error('500'); return { statusCode: 404 }; } };
    const r = await sweepStaleQuotes({ store: { stalePastHold: async () => rows }, trader, release: async (id) => rel.push(id), tracked: (id) => id === 'b' });
    assert.deepStrictEqual(rel, ['a', 'c']); assert.strictEqual(r.usd, 15); assert.strictEqual(r.failed, 1); }

  // 4. Batch: open-combo dup frees a stale row and retries once; without a stale row stays rejected.
  for (const freed of [1, 0]) {
    let calls = 0; const rejected = [];
    const supabase = { from: () => ({ upsert: async (rows) => { calls += 1; if (calls <= 2) return { error: { message: 'duplicate key value violates unique constraint "sniper_ledger_open_combo_uq"' } }; return { error: null }; } }) };
    const st = createBatchedLedgerStore({ releaseStaleCombo: async () => freed }, { supabase, flushMs: 1, log: () => {}, onRejected: (id) => rejected.push(id) });
    st.reserve({ rfqId: 'n1', combo: 'C', games: [], legs: [], risk: 5 }, { releaseAt: Date.now() + 1e4, dryRun: false });
    await st.flush();
    if (freed) { assert.strictEqual(calls, 3); assert.deepStrictEqual(rejected, []); } else { assert.strictEqual(calls, 2); assert.deepStrictEqual(rejected, ['n1']); }
  }
  console.log('stuck-quotes tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
