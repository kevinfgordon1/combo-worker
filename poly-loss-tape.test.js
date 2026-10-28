'use strict';
// Polymarket loss tape: for RFQs we quoted but did not fill, one row with the anonymous print that won
// (or outcome no_print). Pure-module rules + polymarket-rfq hooks (observe-only, quotes unchanged).
const assert = require('assert');
const { createPolyLossTape, createLossRowWriter, lossTapeEnabled } = require('./poly-loss-tape');
const NB = require('./noboost/poly-rfq');
const { startPolymarketRfqLoop } = require('./polymarket-rfq');

// ── off switch ──────────────────────────────────────────────────────────────
assert.strictEqual(lossTapeEnabled({}), true);
assert.strictEqual(lossTapeEnabled({ POLY_LOSS_TAPE: '1' }), true);
assert.strictEqual(lossTapeEnabled({ POLY_LOSS_TAPE: '0' }), false);
assert.strictEqual(lossTapeEnabled({ POLY_LOSS_TAPE: ' 0 ' }), false);

// ── shared matcher helpers (noboost tracker uses the same ones) ─────────────
assert.strictEqual(NB.printWindowEnd(1000, 5000), 10000);
assert.strictEqual(NB.printWindowEnd(1000, null), 1000 + 120000 + 5000);
assert.strictEqual(NB.printInWindow(10000, 20000, 9000), true);   // 1s before create
assert.strictEqual(NB.printInWindow(10000, 20000, 8999), false);
assert.strictEqual(NB.printInWindow(10000, 20000, 25000), true);  // close + 5s
assert.strictEqual(NB.printInWindow(10000, 20000, 25001), false);
assert.strictEqual(NB.printSizeOk(100, 0, 102, 0.2).ok, true);
assert.strictEqual(NB.printSizeOk(100, 0, 103, 0.2).ok, false);
assert.strictEqual(NB.printSizeOk(0, 50, 250, 0.2).ok, true);      // $50 cash, 250 @ 0.20
assert.strictEqual(NB.printSizeOk(0, 50, 300, 0.2).ok, false);
assert.strictEqual(NB.printSizeOk(0, 0, 5, 0.2).unknown, true);

// ── pure tape ───────────────────────────────────────────────────────────────
let T = Date.parse('2026-10-28T18:00:00Z');
const now = () => T;
const iso = (ms) => new Date(ms).toISOString();
const rows = [];
const tape = createPolyLossTape({ persistRow: (r) => rows.push(r), now, finalizeLagMs: 30000 });
const rfq = (id, sym, over = {}) => ({ id, symbol: sym, createdTime: iso(T), qtyDecimal: '100', ...over });
const print = (id, sym, price, qty, ms, side = 'SIDE_BUY') => ({ tradeId: id, symbol: sym, price: String(price), qtyDecimal: String(qty), executedTime: iso(ms), aggressorSide: side });

// 1) lost to a print: we quoted 0.210, the requester traded 60 + 40 at 0.200 (one order, two prints)
tape.noteRfq(rfq('A', 'combo-1'));
tape.onQuoted(rfq('A', 'combo-1'), { quoteId: 'qA', parlayId: 'p1', label: 'L1', buyPrice: '0.210', contracts: 100 });
const t0 = T;
T += 2000; tape.onTrade(print('tr1', 'combo-1', 0.2, 60, T));
tape.onTrade(print('tr1', 'combo-1', 0.2, 60, T)); // duplicate print ignored
T += 500; tape.onTrade(print('tr2', 'combo-1', 0.2, 40, T));
T += 500; tape.onClosed({ id: 'A' });
tape.onTrade(print('trX', 'other-combo', 0.5, 10, T)); // untracked combo ignored

// 2) quoted, no print: requester took no one
tape.onQuoted(rfq('B', 'combo-2'), { quoteId: 'qB', buyPrice: '0.300', contracts: 100 });
tape.onClosed({ id: 'B' });

// 3) we were filled: no row
tape.onQuoted(rfq('C', 'combo-3'), { quoteId: 'qC', buyPrice: '0.400', contracts: 100 });
tape.onOurs({ quoteId: 'qC' });
tape.onTrade(print('trC', 'combo-3', 0.4, 100, T + 100));
tape.onClosed({ id: 'C' });

// 4) ambiguous: another RFQ for the same combo was open at the same time
tape.noteRfq(rfq('D', 'combo-4'));
tape.noteRfq(rfq('D2', 'combo-4', { qtyDecimal: '100' }));
tape.onQuoted(rfq('D', 'combo-4'), { quoteId: 'qD', buyPrice: '0.500', contracts: 100 });
tape.onTrade(print('trD', 'combo-4', 0.48, 100, T + 200, 'SIDE_SELL'));
tape.onClosed({ id: 'D' }); tape.onClosed({ id: 'D2' });

// 5) a print too big for this RFQ does not count
tape.onQuoted(rfq('E', 'combo-5'), { quoteId: 'qE', buyPrice: '0.250', contracts: 100 });
tape.onTrade(print('trE', 'combo-5', 0.24, 500, T + 100));
tape.onClosed({ id: 'E' });

// 6) seen but not quoted: no row
tape.noteRfq(rfq('F', 'combo-6'));
tape.onClosed({ id: 'F' });

assert.strictEqual(tape.sweep(), 0, 'nothing final before window + lag');
T += 5000 + 30001;
assert.strictEqual(tape.sweep(), 4);
assert.strictEqual(tape.sweep(), 0, 'one row per lost request');
const by = Object.fromEntries(rows.map((r) => [r.rfq_id, r]));
assert.deepStrictEqual(Object.keys(by).sort(), ['A', 'B', 'D', 'E']);
assert.strictEqual(by.A.outcome, 'lost_to_print');
assert.strictEqual(by.A.won_price, 0.2);
assert.strictEqual(by.A.won_contracts, 100);
assert.strictEqual(by.A.won_side, 'yes');
assert.strictEqual(by.A.won_at, iso(t0 + 2000));
assert.strictEqual(by.A.our_buy_price, 0.21);
assert.strictEqual(by.A.gap, 0.01);
assert.strictEqual(by.A.gap_cents, 1);
assert.strictEqual(by.A.won_american, 400);
assert.strictEqual(by.A.our_american, 376);
assert.strictEqual(by.A.ambiguous, false);
assert.strictEqual(by.A.other_open_requests, 0);
assert.deepStrictEqual(by.A.trade_ids, ['tr1', 'tr2']);
assert.strictEqual(by.A.close_seen, true);
assert.strictEqual(by.A.quote_id, 'qA');
assert.strictEqual(by.A.parlay_id, 'p1');
assert.strictEqual(by.B.outcome, 'no_print');
assert.strictEqual(by.B.won_price, null);
assert.strictEqual(by.B.ambiguous, false);
assert.strictEqual(by.D.outcome, 'lost_to_print');
assert.strictEqual(by.D.ambiguous, true);
assert.strictEqual(by.D.other_open_requests, 1);
assert.strictEqual(by.D.won_side, 'no');
assert.strictEqual(by.E.outcome, 'no_print');
assert.strictEqual(by.E.size_mismatch_prints, 1);
const st = tape.stats();
assert.strictEqual(st.tracked, 0, 'memory released after finalize');
assert.strictEqual(st.lost_to_print, 2);
assert.strictEqual(st.no_print, 2);

// no close seen: window = created + 120s + 5s
{
  const r2 = []; let t = 1e12; const tp = createPolyLossTape({ persistRow: (r) => r2.push(r), now: () => t, finalizeLagMs: 1000 });
  tp.onQuoted({ id: 'N', symbol: 's', createdTime: new Date(t).toISOString(), cashOrderQty: '50' }, { buyPrice: '0.2' });
  tp.onTrade(print('n1', 's', 0.19, 250, t + 100000));
  t += 125000; assert.strictEqual(tp.sweep(), 0);
  t += 1001; assert.strictEqual(tp.sweep(), 1);
  assert.strictEqual(r2[0].outcome, 'lost_to_print');
  assert.strictEqual(r2[0].close_seen, false);
  assert.strictEqual(r2[0].rfq_cash, 50);
}
// memory cap
{
  const tp = createPolyLossTape({ maxTracked: 2 });
  tp.noteRfq({ id: '1', symbol: 'a' }); tp.noteRfq({ id: '2', symbol: 'a' }); tp.noteRfq({ id: '3', symbol: 'a' });
  assert.strictEqual(tp.stats().tracked, 2); assert.strictEqual(tp.stats().dropped, 1);
}
// a throwing persist never escapes the sweep
{
  let t = 1e12; const tp = createPolyLossTape({ persistRow: () => { throw new Error('x'); }, now: () => t, finalizeLagMs: 0 });
  tp.onQuoted({ id: 'z', symbol: 's', createdTime: new Date(t).toISOString() }, { buyPrice: '0.2' });
  t += 200000; assert.doesNotThrow(() => tp.sweep());
}

(async () => {
  // ── writer: batched upsert; missing table logged once ─────────────────────
  {
    const calls = []; const logs = [];
    const sb = { from: (t) => ({ upsert: async (rws, o) => { calls.push({ t, n: rws.length, o }); return { error: calls.length > 1 ? { message: 'relation does not exist' } : null }; } }) };
    const w = createLossRowWriter({ supabase: sb, log: (m) => logs.push(m), batchMs: 1e9 });
    w.push({ rfq_id: 'a' }); w.push({ rfq_id: 'b' });
    await w.flush();
    assert.deepStrictEqual(calls[0], { t: 'poly_lost_quotes', n: 2, o: { onConflict: 'rfq_id', ignoreDuplicates: true } });
    w.push({ rfq_id: 'c' }); await w.flush(); w.push({ rfq_id: 'd' }); await w.flush();
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(w.stats().written, 2);
  }

  // ── polymarket-rfq hooks: observe-only, quote unchanged ───────────────────
  const SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const lock = {
    id: 'lk', user_id: 'u1', label: 'White Sox ML + Pirates ML',
    parlay_stake: 100, parlay_american: 400, fill_american: 910, hedge_mode: '1x', max_contracts: 1000,
    leg_keys: ['AEC-MLB-BOS-PIT-2026-08-14-PIT:yes', 'AEC-MLB-CWS-DET-2026-08-14-CWS:yes'],
    legs: [
      { symbol: 'aec-mlb-cws-det-2026-08-14-cws', side: 'SIDE_BUY' },
      { symbol: 'aec-mlb-bos-pit-2026-08-14-pit', side: 'SIDE_BUY' },
    ],
  };
  const runLoop = async (lossTape, throwing) => {
    const posts = [];
    const fakeHttp = {
      async getUserId() { return { rfqUserId: 'u' }; }, async listRfqs() { return { rfqs: [] }; },
      async listQuotes() { return { quotes: [] }; }, async getCombo() { return { combos: [] }; },
      async createQuote(body) { posts.push(body); return { quoteId: `q${posts.length}` }; },
      async confirmQuote() { return {}; }, async deleteQuote() { return { statusCode: 200 }; }, close() {},
    };
    const loop = startPolymarketRfqLoop({
      env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
      http: fakeHttp, startWs: false, getParlays: () => [lock], filledSoFarFor: () => 0, getOutstanding: () => 0,
      startedFor: () => ({ started: false }), pendingQuotes: new Map(), reconcileMs: 3600000, staleRfqMs: 30000,
      fetchMarket: async () => null, lossTape: throwing ? new Proxy({}, { get: () => () => { throw new Error('boom'); } }) : lossTape,
    });
    const created = new Date().toISOString();
    const out = await loop.handleRfq({ id: 'L1', symbol: 'combo-L1', status: 'RFQ_STATUS_OPEN', comboLegs: lock.legs, qtyDecimal: '91.61', createdTime: created }, 'ws');
    loop.onWsEvent({ type: 'other', raw: { rfqEvent: { rfqTrade: { trade: { tradeId: 'pt1', symbol: 'combo-L1', price: '0.095', qtyDecimal: '91.61', aggressorSide: 'SIDE_BUY', executedTime: new Date().toISOString() } } } } });
    loop.onWsEvent({ type: 'rfqClosed', rfq: { id: 'L1' } });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    loop.stop();
    return { out, posts };
  };
  const real = createPolyLossTape({ now: () => Date.now() });
  const withTape = await runLoop(real);
  const without = await runLoop(null);
  const boom = await runLoop(null, true);
  assert.strictEqual(withTape.out.post, true);
  assert.deepStrictEqual(withTape.posts, without.posts, 'tape never changes the quote');
  assert.deepStrictEqual(boom.posts, without.posts, 'a throwing tape never touches the quote path');
  assert.strictEqual(real._quoted.get('L1').buyPrice, Number(without.posts[0].buyPrice));
  assert.strictEqual(real._quoted.get('L1').quoteId, 'q1');
  assert.ok(real._rfqs.get('L1').closeMs != null);
  const ev = real.evaluate(real._rfqs.get('L1'), real._quoted.get('L1'));
  assert.strictEqual(ev.outcome, 'lost_to_print');
  assert.strictEqual(ev.won_price, 0.095);
  // the hook is deferred: nothing recorded synchronously inside handleRfq
  {
    const seen = []; const spy = { noteRfq: () => seen.push('n'), onQuoted: () => seen.push('q') };
    const p = (await runLoopSync(spy, seen));
    assert.strictEqual(p, 0, 'no tape call runs synchronously on the quote path');
  }
  console.log('poly-loss-tape tests passed');

  async function runLoopSync(spy, seen) {
    const fakeHttp = {
      async getUserId() { return { rfqUserId: 'u' }; }, async listRfqs() { return { rfqs: [] }; },
      async listQuotes() { return { quotes: [] }; }, async getCombo() { return { combos: [] }; },
      async createQuote() { return { quoteId: 'qq' }; }, async confirmQuote() { return {}; }, async deleteQuote() { return {}; }, close() {},
    };
    const loop = startPolymarketRfqLoop({
      env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: SEED_B64, POLYMARKET_RFQ_LIVE: 'true' },
      http: fakeHttp, startWs: false, getParlays: () => [lock], filledSoFarFor: () => 0, getOutstanding: () => 0,
      startedFor: () => ({ started: false }), pendingQuotes: new Map(), reconcileMs: 3600000, fetchMarket: async () => null, lossTape: spy,
    });
    const pr = loop.handleRfq({ id: 'S1', symbol: 's', status: 'RFQ_STATUS_OPEN', comboLegs: lock.legs, qtyDecimal: '91.61', createdTime: new Date().toISOString() }, 'ws');
    const syncCount = seen.length;
    await pr; loop.stop();
    return syncCount;
  }
})().catch((e) => { console.error(e); process.exit(1); });
