'use strict';
// Oct 28 2026: skip routine TTL DELETEs for quotes Kalshi already reports as cancelled (quote-status
// poll on the READ lane), release them early, and re-check while a DELETE waits for a write token.
// Urgent cancels always go out. Accepted quotes are never touched by the poll.
const assert = require('assert');
const { createLiveSniper } = require('./live');
const { createSniperTrader } = require('./trader');
const { createLimiter } = require('./limiter');
const S = require('../auto-sniper');
const TEST_PEM = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

(async () => {
  const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' });
  const mkRfq = (id) => ({ rfqId: id, marketTicker: 'KXMVE-X', legKeys: ['KXNFLGAME-26NOV01INDJAC-JAC:yes'], contracts: 20, createdTs: Date.now() });
  const mkD = (id) => ({ rfqId: id, quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8.38 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function rig({ ttlMs = 30, cancelGate = null } = {}) {
    const calls = []; const ops = []; let n = 0;
    const trader = { live: true,
      postQuote: async (rfq) => { calls.push(`post:${rfq.rfqId}`); n += 1; return { quoteId: `Q${rfq.rfqId}`, noBid: '0.419', yesBid: '0.00' }; },
      cancel: async (qid, o) => {
        if (cancelGate) await cancelGate;
        if (o && o.skipIf && o.skipIf()) { calls.push(`skip:${qid}`); return { skipped: true }; }
        calls.push(`cancel:${o && o.urgent ? 'urgent' : 'ttl'}:${qid}`); return { statusCode: 204 };
      } };
    const store = { release: async (id, ph) => ops.push(['release', id, ph]), update: async () => true, confirmCheck: async () => ({ ok: true }) };
    const L = createLiveSniper({ config, trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.5, log: () => {}, ttlMs });
    return { L, calls, ops };
  }

  // 1. Kalshi says the quote is cancelled before TTL: released now, no DELETE ever.
  { const h = rig(); await h.L.send(mkRfq('A'), mkD('A'));
    const rel = await h.L.onQuoteStatuses([{ id: 'QA', rfq_id: 'A', status: 'cancelled' }]);
    assert.strictEqual(rel, 1); assert.strictEqual(h.L.pending.size, 0);
    await wait(60);
    assert.deepStrictEqual(h.calls, ['post:A']);
    assert.ok(h.ops.some((o) => o[1] === 'A' && o[2] === 'cancelled'));
    assert.strictEqual(h.L.stats().releasedByPoll, 1); assert.strictEqual(h.L.stats().cancelSent, 0); }

  // 2. Open quote at TTL: DELETE still goes out (unknown state => fail safe), counted as sent.
  { const h = rig(); await h.L.send(mkRfq('B'), mkD('B')); await h.L.onQuoteStatuses([{ id: 'QB', status: 'open' }]); await wait(60);
    assert.deepStrictEqual(h.calls, ['post:B', 'cancel:ttl:QB']); assert.strictEqual(h.L.stats().cancelSent, 1); }

  // 3. TTL DELETE waiting for a write token; poll then reports cancelled => DELETE skipped.
  { let open; const gate = new Promise((r) => { open = r; }); const h = rig({ cancelGate: gate });
    await h.L.send(mkRfq('C'), mkD('C')); await wait(50); // TTL fired, cancel waiting
    await h.L.onQuoteStatuses([{ id: 'QC', status: 'cancelled' }]);
    open(); await wait(10);
    assert.deepStrictEqual(h.calls, ['post:C', 'skip:QC']);
    const st = h.L.stats(); assert.strictEqual(st.cancelAvoided.closed_while_queued, 1); assert.strictEqual(st.cancelSent, 0); }

  // 4. WS rfq_deleted before TTL: still no DELETE, counted as released by ws.
  { const h = rig(); await h.L.send(mkRfq('D'), mkD('D')); await h.L.onRfqClosed({ rfqId: 'D' }); await wait(60);
    assert.deepStrictEqual(h.calls, ['post:D']); assert.strictEqual(h.L.stats().releasedByWs, 1); }

  // 5. Accepted quotes are never released by the poll (WS accept/execute handlers own them).
  { const h = rig({ ttlMs: 5000 }); await h.L.send(mkRfq('E'), mkD('E'));
    h.L.pending.get('QE').accepted = true;
    assert.strictEqual(await h.L.onQuoteStatuses([{ id: 'QE', status: 'cancelled' }]), 0);
    assert.strictEqual(h.L.pending.size, 1);
    // non-cancelled statuses are ignored entirely
    const h2 = rig({ ttlMs: 5000 }); await h2.L.send(mkRfq('F'), mkD('F'));
    for (const st of ['accepted', 'confirmed', 'executed', 'open']) assert.strictEqual(await h2.L.onQuoteStatuses([{ id: 'QF', status: st }]), 0);
    assert.strictEqual(h2.L.pending.size, 1); assert.strictEqual(h2.L.isGone('QF'), false); }

  // 6. Urgent cancels ignore Kalshi status (price move / started game / shutdown always go out).
  { const h = rig({ ttlMs: 5000 }); await h.L.send(mkRfq('G'), mkD('G'));
    const n = await h.L.shutdown(); assert.strictEqual(n, 1);
    assert.deepStrictEqual(h.calls, ['post:G', 'cancel:urgent:QG']); }

  // 7. Quote already known gone when its TTL fires (seen cancelled while it was mid-accept, then the
  //    accept fell through): the TTL path skips the DELETE outright.
  { const h = rig({ ttlMs: 30 }); await h.L.send(mkRfq('H'), mkD('H'));
    h.L.pending.get('QH').accepted = true; await h.L.onQuoteStatuses([{ id: 'QH', status: 'cancelled' }]);
    assert.strictEqual(h.L.pending.size, 1); h.L.pending.get('QH').accepted = false;
    await wait(60);
    assert.deepStrictEqual(h.calls, ['post:H']); assert.strictEqual(h.L.stats().cancelAvoided.quote_gone_kalshi, 1); }

  // 8. trader.listQuotes: one READ-lane GET, self + status + min_ts, cursor paging, no write tokens.
  { const seen = []; const W = createLimiter({ name: 'w', ratePerSec: 100, burst: 5 }); const R = createLimiter({ name: 'r', ratePerSec: 100, burst: 5 });
    const pages = [{ quotes: [{ id: 'q1', status: 'cancelled' }], cursor: 'c2' }, { quotes: [{ id: 'q2', status: 'cancelled' }], cursor: '' }];
    const tr = createSniperTrader({ gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, limiter: W, readLimiter: R, log: () => {},
      request: async ({ method, path }) => { seen.push([method, path]); return { statusCode: 200, headers: {}, text: JSON.stringify(pages[seen.length - 1]) }; } });
    const list = await tr.listQuotes({ minTsSec: 1793000000.7, status: 'cancelled' });
    assert.deepStrictEqual(list.map((q) => q.id), ['q1', 'q2']);
    assert.strictEqual(seen[0][0], 'GET');
    assert.match(seen[0][1], /^\/trade-api\/v2\/communications\/quotes\?/);
    assert.match(seen[0][1], /user_filter=self/); assert.match(seen[0][1], /status=cancelled/); assert.match(seen[0][1], /min_ts=1793000000(&|$)/);
    assert.match(seen[1][1], /cursor=c2/);
    assert.strictEqual(W.stats().requests, 0, 'no write-lane tokens spent'); assert.strictEqual(R.stats().requests, 2); }

  console.log('cancel-skip tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
