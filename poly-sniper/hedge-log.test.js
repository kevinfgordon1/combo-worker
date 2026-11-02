'use strict';
// Polymarket sniper: LOG-ONLY hedge cost on posted quotes + fills (Kevin Nov 2 2026). Quoting unchanged.
const assert = require('assert');
const { createPolySniperLive } = require('./live');
const { decidePoly, polySniperConfig } = require('./engine');
const { createKalshiIndex } = require('./map');
const { fairVenues } = require('./feed');
const { createPolySniperStore } = require('./store');
const S = require('../auto-sniper');
const C = require('../sniper/hedge-cols');

const BASE = Date.parse('2026-10-24T16:00:00Z');
const KICK = Date.parse('2026-10-25T17:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

function mkClock() { const start = Date.now(); const c = { off: 0, now: () => BASE + (Date.now() - start) + c.off }; return c; }
function fakeFeed({ own = 0.6, hedge = true } = {}) {
  const index = createKalshiIndex();
  index.ingestMarkets(['PHIWAS-PHI', 'PHIWAS-WAS', 'NYGDEN-NYG', 'NYGDEN-DEN'].map((x) => ({ ticker: `KXNFLGAME-26OCT25${x}` })));
  const s = { own };
  return {
    s, index, venues: fairVenues({ POLY_SNIPER_FAIR_INCLUDE_POLY: '0' }), pricesHealthy: () => true, tdBook: null, ncaafBook: null,
    kickoffs: { kickoffFor: () => KICK },
    pmLive: { legFair: () => ({ sources: [{ venue: 'novig', used: true, reason: 'ok', cost: 0.45, availUsd: 5000 }],
      ...(hedge ? { hedgeSources: () => [{ venue: 'novig', used: true, reason: 'ok', cost: s.own, ageMs: 100 }, { venue: 'kalshi', used: false, reason: 'depth', ageMs: 100 }] } : {}) }) },
  };
}
function fakeHttp() {
  let seq = 0;
  const h = { calls: { create: [], confirm: [], del: [] }, orders: {}, executed: [], cash: 20000,
    async createQuote(b) { h.calls.create.push(b); return { quoteId: `q${++seq}` }; },
    async confirmQuote(r, q) { h.calls.confirm.push([r, q]); return {}; },
    async deleteQuote(r, q) { h.calls.del.push([r, q]); return { statusCode: 200 }; },
    async getOrder(id) { return h.orders[id] || null; },
    async listQuotes() { return { quotes: h.executed }; },
    async listRfqs() { return { rfqs: [] }; },
    async request(m, p) { return p === '/v1/account/balances' ? { statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: h.cash, buyingPower: h.cash }] } } : { statusCode: 404 }; } };
  return h;
}
function fakeStore() {
  const st = { inserts: [], patches: [],
    async readControl() { return { live: true }; }, async hydrateOpen() { return []; },
    insertQuote(r) { st.inserts.push(r); return Promise.resolve(true); }, patch(id, p) { st.patches.push([id, p]); return Promise.resolve(true); },
    async dayTotals() { return { realized: 0, filledRisk: 0 }; }, async flush() {}, stats: () => ({}) };
  return st;
}
const ML2 = [{ symbol: 'aec-nfl-phi-was-2026-10-25', side: 'SIDE_BUY' }, { symbol: 'aec-nfl-nyg-den-2026-10-25', side: 'SIDE_SELL' }];
let rseq = 0;
const rfq = (clock) => ({ rfqId: `rfq_${++rseq}`, symbol: `crossd-${rseq}`, qtyDecimal: '100', tickSize: 0.001, createdTime: new Date((clock ? clock.now() : BASE) - 50).toISOString(), comboLegs: ML2 });

(async () => {
  // decidePoly: same quote with / without the hedge readers; hedge non-enumerable (not in the decision tape)
  const cfg = polySniperConfig({});
  const r0 = rfq();
  const a = decidePoly(r0, { feed: fakeFeed(), config: cfg, ledger: null, nowMs: BASE, skipLedger: true });
  const b = decidePoly(r0, { feed: fakeFeed({ hedge: false }), config: cfg, ledger: null, nowMs: BASE, skipLedger: true });
  assert.strictEqual(a.action, 'quote', a.reason);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.ok(!JSON.stringify(a).includes('hedge'));
  assert.ok(near(a.hedge.p, 0.36)); assert.strictEqual(a.hedge.mr, 0); assert.strictEqual(a.hedge.q, a.buyPrice);
  assert.ok(near(a.hedge.roi, S.snipeEconomics({ fair: 0.36, q: a.buyPrice, n: a.contracts, makerRate: 0 }).roi));
  assert.strictEqual(a.hedge.legs[0].x.kalshi.r, 'depth'); assert.strictEqual(b.hedge.p, null, 'no own-side book => logged as missing, quote unchanged');

  // live: hedge on the posted-quote insert; hedge_fill on the first fill write (from the confirm-time reprice)
  const clock = mkClock(); const feed = fakeFeed(); const http = fakeHttp(); const store = fakeStore();
  const L = createPolySniperLive({ env: {}, engineConfig: cfg, feed, store, log: () => {}, alert: () => {}, now: clock.now, timers: false });
  await L.attach({ http, comboConfirming: () => 0 });
  const rr = rfq(clock);
  const d = decidePoly(rr, { feed, config: cfg, ledger: null, nowMs: clock.now(), skipLedger: true });
  const p = await L.onDecision(rr, d, { ageMs: 50 });
  assert.ok(p.posted);
  const ins = store.inserts[0];
  assert.ok(near(ins.hedge_prob, 0.36)); assert.deepStrictEqual(ins.hedge, { l: [['n', 0.6, 'dmom'], ['n', 0.6, 'dmom']], m: 0 }); assert.ok(Number.isFinite(ins.hedge_roi));
  assert.strictEqual(ins.buy_price, d.buyPrice); assert.strictEqual(ins.fair, d.fair);
  feed.s.own = 0.62; // books moved by confirm time
  const rec = L._internal.quotes.get(p.quoteId);
  L.onWsEvent({ type: 'quoteAccepted', quote: { id: p.quoteId, rfqId: rr.rfqId, acceptedSide: 'SIDE_BUY', buyQtyDecimal: '40', confirmationDeadline: new Date(clock.now() + 3000).toISOString() } });
  await L.confirmIdle();
  assert.strictEqual(rec.phase, 'confirmed');
  http.orders.o1 = { id: 'o1', cumQuantity: '40', state: 'ORDER_STATE_FILLED' };
  L.onWsEvent({ type: 'quoteExecuted', quote: { id: p.quoteId, rfqId: rr.rfqId, creatorOrderId: 'o1', status: 'QUOTE_STATUS_EXECUTED', buyQtyDecimal: '40' } });
  await sleep(20);
  const fp = store.patches.filter(([id, x]) => id === p.quoteId && x.filled_contracts > 0);
  assert.ok(fp.length >= 1);
  const hf = fp[0][1].hedge_fill;
  assert.ok(hf && near(hf.p, 0.62 * 0.62)); assert.strictEqual(hf.q, rec.buyPrice); assert.strictEqual(hf.n, 40); assert.ok(hf.at);
  assert.ok(near(hf.roi, S.snipeEconomics({ fair: 0.62 * 0.62, q: rec.buyPrice, n: 40, makerRate: 0 }).roi));
  assert.ok(fp.slice(1).every(([, x]) => !('hedge_fill' in x)), 'hedge_fill written once');

  // store: missing hedge columns (migration not run) => rows still written without them
  C._resetHedgeCols();
  const missing = { message: "Could not find the 'hedge' column of 'poly_sniper_ledger' in the schema cache" };
  const ups = []; const upd = [];
  const sb = { from: () => ({
    upsert: async (r) => { ups.push(r); return { error: 'hedge' in r ? missing : null }; },
    update: (x) => ({ eq: async () => { upd.push(x); return { error: 'hedge_fill' in x ? missing : null }; } }),
  }) };
  const ps = createPolySniperStore({ supabase: sb, log: () => {}, retries: 0, retryMs: 0, sleep: async () => {} });
  assert.strictEqual(await ps.insertQuote({ quote_id: 'x1', phase: 'quoted', quoted_risk: 1, hedge: { p: 1 }, hedge_prob: 1, hedge_roi: 0 }), true);
  assert.strictEqual(ups.length, 2); assert.ok(!('hedge' in ups[1])); assert.strictEqual(ups[1].quoted_risk, 1);
  assert.strictEqual(await ps.patch('x1', { phase: 'filled', hedge_fill: {} }), true);
  assert.strictEqual(upd.length, 1, 'known missing => stripped before the write'); assert.ok(!('hedge_fill' in upd[0]));
  C._resetHedgeCols();
  assert.strictEqual(await ps.patch('x1', { phase: 'filled', hedge_fill: {} }), true);
  assert.strictEqual(upd.length, 3); assert.ok(!('hedge_fill' in upd[2]));
  await L.shutdown('test').catch(() => {});
  console.log('poly-sniper/hedge-log.test.js ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
