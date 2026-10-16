'use strict';
const assert = require('assert');
const { createPolyRfqTracker, normalizePolyRfq, normalizePolyTrade, polyComboTakerFee } = require('./poly-rfq');
const { makeBook } = require('./test-util');

let T = Date.parse('2026-10-16T06:00:00Z');
const now = () => T;
const book = makeBook([{ game: '26OCT18BUFMIA', a: 'BUF', b: 'MIA', askA: 0.62, bidA: 0.6, askB: 0.41, bidB: 0.39 }, { game: '26OCT18KCLV', a: 'KC', b: 'LV', askA: 0.75, bidA: 0.73, askB: 0.28, bidB: 0.26 }]);
const rows = [];
const mk = () => createPolyRfqTracker({ book, now, persistRow: (r) => rows.push(r), priceFairs: () => ({ fair_mid_american: 250 }), runId: 't' });
const legs = [{ symbol: 'aec-nfl-buf-mia-2026-10-18', side: 'SIDE_SELL' }, { symbol: 'aec-nfl-kc-lv-2026-10-18', side: 'SIDE_BUY' }];
const rfq = (id, extra = {}) => normalizePolyRfq({ rfq: { id, symbol: 'caoc-x1', status: 'RFQ_STATUS_OPEN', comboLegs: legs, qtyDecimal: '100', createdTime: new Date(T).toISOString(), tickSize: 0.001, ...extra } }, T);
const trade = (id, ms, price = '0.2', qty = '100', side = 'SIDE_BUY') => normalizePolyTrade({ tradeId: id, symbol: 'caoc-x1', price, qtyDecimal: qty, aggressorSide: side, executedTime: new Date(ms).toISOString() });

// fee: docs table — 100-lot at $0.10 pays $1.02, at $0.50 pays $1.92
assert.ok(Math.abs(100 * polyComboTakerFee(0.1) - 1.02) < 0.006);
assert.ok(Math.abs(100 * polyComboTakerFee(0.5) - 1.92) < 0.006); // docs table rounds 1.925 -> 1.92

{ // happy path: logged with venue, Kalshi-mapped legs, matched first print, multi-fill aggregated, dedupe
  const p = mk(); rows.length = 0;
  const rec = p.onRfq(rfq('r1'));
  assert.ok(rec);
  assert.deepStrictEqual(rec.legs, ['aec-nfl-buf-mia-2026-10-18:no', 'aec-nfl-kc-lv-2026-10-18:yes']);
  assert.deepStrictEqual(rec.legs_kalshi, ['KXNFLGAME-26OCT18BUFMIA-MIA:yes', 'KXNFLGAME-26OCT18KCLV-KC:yes']);
  assert.strictEqual(rows[0].venue, 'polymarket'); assert.strictEqual(rows[0].outcome, 'pending');
  T += 1500; p.onClosed({ rfq: { id: 'r1', status: 'RFQ_STATUS_CLOSED' } });
  const m = p.onTrade(trade('t1', T + 100, '0.2', '60'));
  assert.strictEqual(m.outcome, 'traded'); assert.strictEqual(m.traded_yes, 0.2);
  p.onTrade(trade('t1', T + 100, '0.2', '60')); // duplicate (WS + backfill)
  p.onTrade(trade('t2', T + 200, '0.2', '40'));
  assert.strictEqual(m.traded_contracts, 100); assert.strictEqual(m.match_ambiguous, false);
  const last = rows[rows.length - 1]; assert.strictEqual(last.traded_american, 400); assert.deepStrictEqual(last.poly_trade_ids, ['t1', 't2']);
}
{ // print after close+5s does not match; size mismatch does not match; no print -> accepted_not_filled
  const p = mk(); rows.length = 0;
  p.onRfq(rfq('r2')); T += 1000; p.onClosed({ rfq: { id: 'r2' } });
  assert.strictEqual(p.onTrade(trade('t3', T + 6000)), null);
  assert.strictEqual(p.onTrade(trade('t4', T + 1000, '0.2', '500')), null);
  T += 400000; p.sweep();
  assert.strictEqual(rows[rows.length - 1].outcome, 'accepted_not_filled');
  assert.strictEqual(p.byId.size, 0);
}
{ // two identical overlapping RFQs -> ambiguous, latest created before print taken
  const p = mk(); rows.length = 0;
  p.onRfq(rfq('a')); T += 500; p.onRfq(rfq('b'));
  const m = p.onTrade(trade('t5', T + 300));
  assert.strictEqual(m.rfq_id, 'b'); assert.strictEqual(m.match_ambiguous, true);
}
{ // out of scope (non-NFL) is not logged; SELL aggressor -> taker_no
  const p = mk(); rows.length = 0;
  assert.strictEqual(p.onRfq(rfq('x', { comboLegs: [{ symbol: 'aec-mlb-nyy-bos-2026-10-18' }, { symbol: 'aec-mlb-lad-sd-2026-10-18' }] })), null);
  assert.strictEqual(rows.length, 0);
  p.onRfq(rfq('y')); const m = p.onTrade(trade('t6', T + 200, '0.3', '100', 'SIDE_SELL'));
  assert.strictEqual(m.outcome, 'taker_no');
}
console.log('poly-rfq tests ok');
{ // every persisted row has the same key set even when fairs are missing (PostgREST PGRST102)
  const out = [];
  const p = createPolyRfqTracker({ book, now, persistRow: (r) => out.push(r), priceFairs: () => ({}) });
  const p2 = createPolyRfqTracker({ book, now, persistRow: (r) => out.push(r), priceFairs: () => ({ fair_mid_american: 300, fair_promo_best_american: 310, pm_inverse_legs: [] }) });
  p.onRfq(rfq('k1')); p2.onRfq(rfq('k2'));
  const keys = (r) => Object.keys(JSON.parse(JSON.stringify(r))).sort().join(',');
  assert.strictEqual(keys(out[0]), keys(out[1]));
  console.log('poly-rfq row keys ok');
}
{ // a failing Polymarket batch never blocks Kalshi patches / stats
  const { createStore } = require('./store');
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push(`${o.method} ${url.split('/rest/v1/')[1].split('?')[0]}`); const bad = o.method === 'POST' && /"venue":"polymarket"/.test(o.body || ''); return { ok: !bad, status: bad ? 400 : 201, text: async () => 'PGRST102' }; };
  const st = createStore({ url: 'http://x', key: 'k', fetchImpl, log: () => {} });
  st.persistRow({ rfq_id: 'p1', venue: 'polymarket' }); st.persist({ rfq_id: 'k1', settled: true }, 'patch'); st.persistStats({ a: 1 });
  st.flush().then(() => {
    assert.ok(calls.includes('PATCH noboost_paper_rfqs')); assert.ok(calls.includes('POST noboost_paper_stats'));
    console.log('store isolation ok');
  });
}
