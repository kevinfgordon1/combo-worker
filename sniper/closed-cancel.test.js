'use strict';
// Routine 20s TTL cancels are skipped when Kalshi already closed/deleted the RFQ (our quote is
// gone with it). Urgent cancels (price move / started game / decline / shutdown) always go out.
const assert = require('assert');
const { createLiveSniper } = require('./live');
const { createLimiter } = require('./limiter');
const { createSniperTrader } = require('./trader');
const { createDeletedFilter } = require('./intake');
const S = require('../auto-sniper');

(async () => {
  const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' });
  const rfq = { rfqId: 'R1', marketTicker: 'KXMVE-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes'], contracts: 20, createdTs: Date.now() };
  const d = { rfqId: 'R1', quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8.38 };
  function rig({ postGate = null, started = null } = {}) {
    const calls = []; const ops = [];
    const trader = { live: true,
      postQuote: async () => { calls.push('post'); if (postGate) await postGate; return { quoteId: 'Q1', noBid: '0.419', yesBid: '0.00' }; },
      cancel: async (qid, o) => { calls.push(`cancel:${o && o.urgent ? 'urgent' : 'ttl'}`); if (o && o.skipIf && o.skipIf()) return { skipped: true }; return { statusCode: 204 }; } };
    const store = { release: async (id, ph) => ops.push(['release', id, ph]), update: async () => true };
    const L = createLiveSniper({ config, trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.5, log: () => {}, ttlMs: 20, startedReason: () => started && started.v });
    return { L, calls, ops };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1. TTL fires on an open RFQ: routine cancel still goes out.
  { const h = rig(); await h.L.send(rfq, d); await wait(40);
    assert.deepStrictEqual(h.calls, ['post', 'cancel:ttl']); assert.strictEqual(h.L.stats().cancelSkipped, 0); }

  // 2. RFQ closed while quoted: released, TTL cancel never sent.
  { const h = rig(); await h.L.send(rfq, d); await h.L.onRfqClosed({ rfqId: 'R1' }); await wait(40);
    assert.deepStrictEqual(h.calls, ['post']); assert.strictEqual(h.L.pending.size, 0);
    assert.ok(h.ops.some((o) => o[0] === 'release' && o[2] === 'cancelled')); }

  // 3. RFQ closed while our POST was in flight: no TTL timer, no cancel, row released.
  { let open; const gate = new Promise((r) => { open = r; }); const h = rig({ postGate: gate });
    const p = h.L.send(rfq, d);
    await wait(0);
    // the ws deleted-filter must keep this frame (RFQ in flight)
    const keep = createDeletedFilter((cb) => h.L.forEachRfqId(cb));
    assert.strictEqual(keep('{"type":"rfq_deleted","msg":{"id":"R1"}}'), false);
    await h.L.onRfqClosed({ rfqId: 'R1' }); open(); const res = await p;
    assert.strictEqual(res.sent, true); await wait(40);
    assert.deepStrictEqual(h.calls, ['post']); assert.strictEqual(h.L.pending.size, 0); assert.strictEqual(h.L.stats().cancelSkipped, 1);
    assert.ok(h.ops.some((o) => o[0] === 'release' && o[2] === 'cancelled')); }

  // 4. Urgent cancel (started game) still goes out even if the RFQ is already marked closed.
  { const started = { v: null }; const h = rig({ started }); await h.L.send(rfq, d);
    started.v = 'game_started'; await h.L.pullStarted();
    assert.deepStrictEqual(h.calls, ['post', 'cancel:urgent']); }

  // 5. Limiter abortIf: a queued low-priority call gives up without spending a token.
  { let t = 0; const lim = createLimiter({ name: 'x', ratePerSec: 1, burst: 1, now: () => t, sleep: async (ms) => { t += ms; } });
    let ran = 0; await lim.run(async () => { ran += 1; return { ok: true, status: 200 }; });
    let closed = false; let checks = 0;
    const r = await lim.run(async () => { ran += 1; return { ok: true, status: 200 }; }, { priority: 0, abortIf: () => { checks += 1; if (checks > 1) closed = true; return closed; } });
    assert.deepStrictEqual(r, { aborted: true }); assert.strictEqual(ran, 1); assert.strictEqual(lim.stats().aborted, 1); }

  // 6. Trader: routine cancel with skipIf true sends no DELETE; urgent ignores skipIf.
  { const crypto = require('crypto'); const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    let deletes = 0; let t = 0;
    const lim = createLimiter({ name: 'w', ratePerSec: 5, burst: 1, now: () => t, sleep: async (ms) => { t += ms; } });
    const tr = createSniperTrader({ gate: { live: true }, keyId: 'k', pem, subaccount: 7, limiter: lim, log: () => {}, request: async () => { deletes += 1; return { statusCode: 204, headers: {}, text: '' }; } });
    const r1 = await tr.cancel('Q', { urgent: false, skipIf: () => true });
    assert.deepStrictEqual(r1, { skipped: true }); assert.strictEqual(deletes, 0); assert.strictEqual(tr.stats().cancelsSkipped, 1);
    await tr.cancel('Q', { urgent: true, skipIf: () => true }); assert.strictEqual(deletes, 1);
    await tr.cancel('Q', { urgent: false, skipIf: () => false }); assert.strictEqual(deletes, 2); }

  console.log('closed-cancel tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
