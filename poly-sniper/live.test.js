'use strict';
// Polymarket sniper LIVE layer (Kevin Oct 29, preview): caps = Kalshi sniper caps, fills-only exposure,
// re-check at confirm, decline pause, stale cancels, startup cleanup, switch off deletes, fills booked
// through the #308 resolveQuoteFill path, and Combo Locks never sees sniper events.
const assert = require('assert');
const { createPolySniperLive, liveConfig, capReason, comboSettlement, createBucket } = require('./live');
const { polySniperConfig } = require('./engine');
const { createKalshiIndex } = require('./map');
const { fairVenues } = require('./feed');
const { createPolySniper } = require('./index');
const { startPolymarketRfqLoop } = require('../polymarket-rfq');

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const BASE = Date.parse('2026-10-24T16:00:00Z');
const KICK = Date.parse('2026-10-25T17:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkClock() { const start = Date.now(); const c = { off: 0, now: () => BASE + (Date.now() - start) + c.off }; return c; }
function fakeFeed(state = {}) {
  const s = { cost: 0.45, healthy: true, kickoffMs: KICK, ...state };
  const index = createKalshiIndex();
  index.ingestMarkets(['PHIWAS-PHI', 'PHIWAS-WAS', 'NYGDEN-NYG', 'NYGDEN-DEN', 'BUFNYJ-BUF', 'BUFNYJ-NYJ'].map((x) => ({ ticker: `KXNFLGAME-26OCT25${x}` })));
  return {
    s, index, venues: fairVenues({ POLY_SNIPER_FAIR_INCLUDE_POLY: '0' }), pricesHealthy: () => s.healthy, tdBook: null, ncaafBook: null,
    kickoffs: { kickoffFor: () => s.kickoffMs },
    pmLive: { legFair: () => ({ sources: [{ venue: 'novig', used: true, reason: 'ok', cost: s.cost, availUsd: 5000 }] }) },
  };
}
function fakeHttp() {
  let seq = 0;
  const h = {
    calls: { create: [], confirm: [], del: [] }, orders: {}, executed: [], rfqs: {}, cash: 20000, confirmDelayMs: 0,
    async createQuote(b) { h.calls.create.push(b); return { quoteId: `q${++seq}` }; },
    async confirmQuote(r, q) { if (h.confirmDelayMs) await sleep(h.confirmDelayMs); h.calls.confirm.push([r, q]); return {}; },
    async deleteQuote(r, q) { h.calls.del.push([r, q]); return { statusCode: 200 }; },
    async getOrder(id) { return h.orders[id] || null; },
    async listQuotes() { return { quotes: h.executed }; },
    async listRfqs(q) { return { rfqs: h.rfqs[q.rfqId] ? [h.rfqs[q.rfqId]] : [] }; },
    async request(m, p) { return p === '/v1/account/balances' ? { statusCode: 200, json: { balances: [{ currency: 'USD', currentBalance: h.cash, buyingPower: h.cash }] } } : { statusCode: 404 }; },
  };
  return h;
}
function fakeStore({ live = true, rows = [] } = {}) {
  const st = {
    ctl: { live }, rows, inserts: [], patches: [],
    async readControl() { if (st.fail) throw new Error('db down'); return { live: st.ctl.live }; },
    async hydrateOpen() { return st.rows; },
    insertQuote(r) { st.inserts.push(r); return Promise.resolve(true); },
    patch(id, p) { st.patches.push([id, p]); return Promise.resolve(true); },
    async dayTotals() { return { realized: 0, filledRisk: 0 }; },
    async flush() {},
    stats: () => ({}),
  };
  return st;
}
let rseq = 0;
const ML2 = [{ symbol: 'aec-nfl-phi-was-2026-10-25', side: 'SIDE_BUY' }, { symbol: 'aec-nfl-nyg-den-2026-10-25', side: 'SIDE_SELL' }];
const ML2b = [{ symbol: 'aec-nfl-phi-was-2026-10-25', side: 'SIDE_SELL' }, { symbol: 'aec-nfl-buf-nyj-2026-10-25', side: 'SIDE_BUY' }];
const rfq = (legs = ML2, qty = '100', clock) => ({ rfqId: `rfq_${++rseq}`, symbol: `crossd-${rseq}`, qtyDecimal: qty, tickSize: 0.001, createdTime: new Date((clock ? clock.now() : BASE) - 50).toISOString(), comboLegs: legs });

async function setup({ env = {}, live = true, rows = [], feedState = {}, cash = 20000 } = {}) {
  const clock = mkClock(); const feed = fakeFeed(feedState); const http = fakeHttp(); http.cash = cash; const store = fakeStore({ live, rows });
  const logs = []; const alerts = [];
  const engineConfig = polySniperConfig(env);
  let comboN = 0;
  const L = createPolySniperLive({ env, engineConfig, feed, store, log: (m) => logs.push(m), alert: (m) => alerts.push(m), now: clock.now, timers: false });
  await L.attach({ http, comboConfirming: () => comboN });
  const { decidePoly } = require('./engine');
  const decide = (r) => decidePoly(r, { feed, config: engineConfig, ledger: null, nowMs: clock.now(), skipLedger: true });
  const post = async (r) => { const d = decide(r); assert.strictEqual(d.action, 'quote', d.reason); return L.onDecision(r, d, { ageMs: 50 }); };
  const accept = async (quoteId, rfqId, qty, extra = {}) => { L.onWsEvent({ type: 'quoteAccepted', quote: { id: quoteId, rfqId, acceptedSide: 'SIDE_BUY', buyQtyDecimal: String(qty), confirmationDeadline: new Date(clock.now() + 3000).toISOString(), ...extra } }); await L.confirmIdle(); };
  return { L, clock, feed, http, store, logs, alerts, post, decide, accept, setCombo: (k) => { comboN = k; } };
}

t('caps default to the Kalshi sniper values', () => {
  const c = liveConfig({});
  assert.deepStrictEqual(
    [c.maxRisk, c.maxPayout, c.perGameCap, c.perLegCap, c.totalExposureCap, c.longExposureCap, c.shortSettleHours, c.dailyRiskCap, c.dailyLossCap, c.soonCap, c.soonHours, c.maxLegDays],
    [400, 100000, 1500, 750, 10000, 5000, 48, 10000, 10000, true, 24, 7]);
  const e = polySniperConfig({});
  assert.deepStrictEqual([e.maxRisk, e.perGameCap, e.perLegCap, e.totalExposureCap, e.dailyRiskCap], [400, 1500, 750, 10000, 10000]);
  // min edges: nothing below 5% (Kevin Oct 30: NFL ML 3%->5%, other NFL 4%->5%)
  assert.deepStrictEqual([e.minRoiNflMl, e.minRoiNfl, e.minRoiTd, e.minRoiNcaaf, e.minRoiNba], [0.05, 0.05, 0.06, 0.05, 0.06]);
  assert.strictEqual(c.postRps, 20); assert.strictEqual(c.declinePauseRatio, 0.10);
});

t('capReason: every Kalshi rule, plus cash floor', () => {
  const c = liveConfig({}); const now = BASE; const ok = { cashUsd: 20000, cashAt: now, nowMs: now };
  const pos = (x = {}) => ({ risk: 100, contracts: 150, games: ['G1'], legs: ['L1:yes'], combo: 'C', settleAt: now + 30 * 3600e3, legKickoffs: [now + 26 * 3600e3], ...x });
  const bk = (positions = [], x = {}) => ({ positions, dayRisk: 0, dayLoss: 0, ...x });
  assert.strictEqual(capReason(pos(), bk(), c, ok), null);
  assert.strictEqual(capReason(pos({ risk: 401 }), bk(), c, ok), 'risk_over_cap');
  assert.strictEqual(capReason(pos({ contracts: 100001 }), bk(), c, ok), 'payout_over_cap');
  assert.strictEqual(capReason(pos(), bk([], { dayLoss: -10000 }), c, ok), 'daily_loss_halt');
  assert.strictEqual(capReason(pos({ legKickoffs: [now + 8 * 864e5] }), bk(), c, ok), 'leg_too_far');
  assert.strictEqual(capReason(pos(), bk(), c, { nowMs: now, cashUsd: null }), 'cash_unknown');
  assert.strictEqual(capReason(pos(), bk(), c, { nowMs: now, cashUsd: 20000, cashAt: now - 5 * 60000 }), 'cash_unknown');
  assert.strictEqual(capReason(pos({ risk: 300 }), bk(), c, { ...ok, cashUsd: 5200 }), 'cash_floor');
  assert.strictEqual(capReason(pos(), bk([{ risk: 50, combo: 'C' }]), c, ok), 'already_hold_combo');
  assert.strictEqual(capReason(pos(), bk([{ risk: 9950, games: ['X'] }]), c, ok), 'total_cap');
  // soon-cap: settles within 24h -> total cap = cash above the floor (never below $10,000)
  assert.strictEqual(capReason(pos({ settleAt: now + 10 * 3600e3 }), bk([{ risk: 9950, games: ['X'] }]), c, { ...ok, cashUsd: 30000 }), null);
  assert.strictEqual(capReason(pos({ settleAt: now + 10 * 3600e3 }), bk([{ risk: 9950, games: ['X'] }]), c, { ...ok, cashUsd: 12000 }), 'total_cap');
  assert.strictEqual(capReason(pos({ settleAt: now + 60 * 3600e3, legKickoffs: [] }), bk([{ risk: 4950, long: true, games: ['X'] }]), c, ok), 'cap_total_long');
  assert.strictEqual(capReason(pos(), bk([{ risk: 1450, games: ['G1'] }]), c, ok), 'game_cap');
  assert.strictEqual(capReason(pos(), bk([{ risk: 700, games: ['X'], legs: ['L1:yes'] }]), c, ok), 'leg_cap');
  assert.strictEqual(capReason(pos(), bk([], { dayRisk: 9950 }), c, ok), 'daily_risk_cap');
});

t('switch defaults off: nothing is posted', async () => {
  const S = await setup({ live: false });
  const r = await S.post(rfq());
  assert.strictEqual(r.posted, false); assert.strictEqual(r.reason, 'switch_off'); assert.strictEqual(S.http.calls.create.length, 0);
});

t('switch on: posts buy side only, resting quotes count $0, post bucket caps bursts at 20', async () => {
  const S = await setup();
  const out = [];
  for (let i = 0; i < 25; i += 1) out.push(await S.post(rfq(ML2, '500'))); // ~$344 risk each, same 2 games
  const posted = out.filter((x) => x.posted).length;
  assert.strictEqual(posted, 20, JSON.stringify(out.map((x) => x.reason)));
  assert.strictEqual(out.filter((x) => x.reason === 'post_rate').length, 5);
  const b = S.http.calls.create[0];
  assert.strictEqual(b.sellPrice, '0'); assert.strictEqual(b.restRemainder, false); assert.ok(Number(b.buyPrice) > 0.3);
  // 20 resting quotes x $344 on one game = $6,880 > $1,500 game cap: allowed because nothing has filled.
  assert.strictEqual(S.L.stats().openRisk, 0);
});

t('confirm re-checks caps with real exposure: second accept on the same game is declined', async () => {
  // Fixture sized for a ~$399 fill at the old 3% NFL ML floor; pinned so this stays a cap test, not an edge test.
  const S = await setup({ env: { POLY_SNIPER_MIN_ROI_NFL_ML: '0.03' } });
  const a = await S.post(rfq(ML2, '580')); const b = await S.post(rfq(ML2b, '580'));
  const qa = S.L._internal.quotes.get(a.quoteId); const qb = S.L._internal.quotes.get(b.quoteId);
  await S.accept(a.quoteId, qa.rfqId, 580);
  assert.deepStrictEqual(S.http.calls.confirm, [[qa.rfqId, a.quoteId]]);
  assert.ok(S.L.stats().openRisk > 390 && S.L.stats().openRisk <= 400);
  // Game PHIWAS now holds ~$399; push it to the cap with more fills.
  S.L._internal.quotes.get(a.quoteId).risk = 1400;
  await S.accept(b.quoteId, qb.rfqId, 580);
  assert.strictEqual(S.http.calls.confirm.length, 1);
  assert.ok(S.http.calls.del.some(([, q]) => q === b.quoteId));
  assert.ok(S.logs.some((l) => /DECLINED .*cap:game_cap/.test(l)));
});

t('confirm re-prices: fair moved past the edge -> decline; deadline passed -> decline', async () => {
  const S = await setup({ env: { POLY_SNIPER_DECLINE_PAUSE_RATIO: '1' } });
  const a = await S.post(rfq());
  S.feed.s.cost = 0.40; // each leg fair 0.60 -> combo 0.36, our ~0.312 price is now under fair
  await S.accept(a.quoteId, S.L._internal.quotes.get(a.quoteId).rfqId, 100);
  assert.strictEqual(S.http.calls.confirm.length, 0);
  assert.ok(S.logs.some((l) => /DECLINED .*reprice:fair_moved|reprice:roi_below_min/.test(l)), S.logs.join('\n'));
  S.feed.s.cost = 0.45;
  const b = await S.post(rfq());
  await S.accept(b.quoteId, S.L._internal.quotes.get(b.quoteId).rfqId, 100, { confirmationDeadline: new Date(S.clock.now() + 100).toISOString() });
  assert.strictEqual(S.http.calls.confirm.length, 0);
  assert.ok(S.logs.some((l) => /DECLINED .*deadline/.test(l)));
});

t('Combo Locks confirms go first: sniper confirm waits for an in-flight Combo Locks confirm', async () => {
  const S = await setup();
  const a = await S.post(rfq());
  S.setCombo(1); setTimeout(() => S.setCombo(0), 60);
  const t0 = Date.now();
  await S.accept(a.quoteId, S.L._internal.quotes.get(a.quoteId).rfqId, 100);
  assert.ok(Date.now() - t0 >= 50, `waited ${Date.now() - t0}ms`);
  assert.strictEqual(S.http.calls.confirm.length, 1);
});

t('declines over 10% of accepts in an hour pause the sniper and delete its open quotes', async () => {
  const S = await setup();
  const keep = await S.post(rfq(ML2b));
  const a = await S.post(rfq());
  S.feed.s.cost = 0.40;
  await S.accept(a.quoteId, S.L._internal.quotes.get(a.quoteId).rfqId, 100); // 1 decline / 1 accept
  S.feed.s.cost = 0.45;
  assert.ok(/paused:decline_rate/.test(S.L.state()));
  await sleep(20);
  assert.ok(S.http.calls.del.some(([, q]) => q === keep.quoteId));
  const r = await S.post(rfq());
  assert.strictEqual(r.posted, false); assert.ok(/paused/.test(r.reason));
  assert.ok(S.alerts.some((m) => /PAUSED/.test(m)));
});

t('account-wide: Combo Locks declines count, sniper pauses only when it also declined', async () => {
  const S = await setup();
  for (let i = 0; i < 5; i += 1) S.L.onComboAcceptOutcome(false);
  assert.strictEqual(S.L.state(), 'live'); // sniper has no declines: pausing it would not help
});

t('switch off deletes every open sniper quote and declines accepts; no restart needed', async () => {
  const S = await setup();
  const a = await S.post(rfq()); const b = await S.post(rfq(ML2b));
  S.store.ctl.live = false;
  await S.L._internal.pollControl();
  await sleep(20);
  const deleted = S.http.calls.del.map(([, q]) => q).sort();
  assert.deepStrictEqual(deleted, [a.quoteId, b.quoteId].sort());
  assert.strictEqual(S.L.state(), 'switch_off');
  S.store.ctl.live = true; await S.L._internal.pollControl();
  assert.strictEqual(S.L.state(), 'live');
});

t('control read failing > 30s = off (fail closed)', async () => {
  const S = await setup();
  await S.post(rfq());
  S.store.fail = true; S.clock.off += 31000;
  await S.L._internal.pollControl(); await sleep(10);
  assert.strictEqual(S.L.state(), 'switch_off'); assert.strictEqual(S.http.calls.del.length, 1);
});

t('stale sweep cancels on stale prices, fair moved, near game start, TTL', async () => {
  const S = await setup();
  const q1 = await S.post(rfq());
  S.feed.s.healthy = false; S.L._internal.sweep(); S.feed.s.healthy = true; await sleep(10);
  assert.ok(S.http.calls.del.some(([, q]) => q === q1.quoteId));
  const q2 = await S.post(rfq()); S.feed.s.cost = 0.40; S.L._internal.sweep(); S.feed.s.cost = 0.45; await sleep(10);
  assert.ok(S.http.calls.del.some(([, q]) => q === q2.quoteId));
  const q3 = await S.post(rfq()); S.feed.s.kickoffMs = S.clock.now() + 20 * 60000; S.L._internal.sweep(); S.feed.s.kickoffMs = KICK; await sleep(10);
  assert.ok(S.http.calls.del.some(([, q]) => q === q3.quoteId));
  const q4 = await S.post(rfq()); S.clock.off += 61000; S.L._internal.sweep(); await sleep(10);
  assert.ok(S.http.calls.del.some(([, q]) => q === q4.quoteId));
  assert.strictEqual(S.L.stats().open, 0);
});

t('Polymarket RFQ feed stall cancels everything and blocks posting until recovered', async () => {
  const S = await setup();
  const q = await S.post(rfq());
  S.L.onWsStall(); await sleep(10);
  assert.ok(S.http.calls.del.some(([, x]) => x === q.quoteId));
  assert.strictEqual((await S.post(rfq())).reason, 'feed_stall');
  S.L.onWsRecovered();
  assert.strictEqual((await S.post(rfq())).posted, true);
});

t('cash floor keeps Combo Locks funded: no post when cash - risk < floor', async () => {
  const S = await setup({ cash: 5300 });
  const r = await S.post(rfq(ML2, '500')); // ~$344 risk
  assert.strictEqual(r.posted, false); assert.strictEqual(r.reason, 'cash_floor');
});

t('startup cleanup deletes leftover own quotes; open fills count toward caps', async () => {
  const rows = [
    { quote_id: 'old1', rfq_id: 'r1', phase: 'quoted', buy_price: 0.3, contracts: 10, created_at: new Date(BASE).toISOString() },
    { quote_id: 'old2', rfq_id: 'r2', phase: 'accepted', buy_price: 0.3, contracts: 10, created_at: new Date(BASE).toISOString() },
    { quote_id: 'f1', rfq_id: 'r3', phase: 'filled', buy_price: 0.3, contracts: 2000, filled_contracts: 2000, filled_cost: 600, risk: 1400, games: ['26OCT25PHIWAS'], legs: [], combo_key: 'zz', settle_at: new Date(KICK + 4 * 3600e3).toISOString(), created_at: new Date(BASE).toISOString(), fill_ids: ['x'] },
  ];
  const S = await setup({ rows });
  await sleep(20);
  assert.deepStrictEqual(S.http.calls.del.map(([, q]) => q).sort(), ['old1', 'old2']);
  assert.strictEqual(S.L.stats().openRisk, 1400);
  // A new accept on the same game would exceed $1,500: posting still allowed (resting=$0) only under the game cap
  const r = await S.post(rfq(ML2, '580'));
  assert.strictEqual(r.posted, false); assert.strictEqual(r.reason, 'game_cap');
});

t('fills book through the #308 resolveQuoteFill path; risk = filled worst case; Combo Locks skips them', async () => {
  const S = await setup();
  const a = await S.post(rfq());
  const rec = S.L._internal.quotes.get(a.quoteId);
  await S.accept(a.quoteId, rec.rfqId, 100);
  S.http.orders.ord1 = { id: 'ord1', cumQuantity: '100', state: 'ORDER_STATE_FILLED' };
  S.L.onWsEvent({ type: 'quoteExecuted', quote: { id: a.quoteId, rfqId: rec.rfqId, creatorOrderId: 'ord1', status: 'QUOTE_STATUS_EXECUTED', buyQtyDecimal: '100' } });
  await sleep(20);
  assert.strictEqual(rec.phase, 'filled'); assert.strictEqual(rec.filled, 100);
  assert.ok(Math.abs(rec.risk - 100 * (1 - rec.buyPrice)) < 1e-6);
  assert.ok(S.store.patches.some(([id, p]) => id === a.quoteId && p.phase === 'filled' && p.filled_contracts === 100));
  // replay is not double-booked
  S.L.onWsEvent({ type: 'quoteExecuted', quote: { id: a.quoteId, rfqId: rec.rfqId, creatorOrderId: 'ord1' } }); await sleep(10);
  assert.strictEqual(rec.filled, 100);
  // Combo Locks reconcile guard
  assert.strictEqual(S.L.isSniperFill({ quoteId: a.quoteId }), true);
  assert.strictEqual(S.L.isSniperFill({ orderId: 'ord1' }), true);
  assert.strictEqual(S.L.isSniperFill({ marketTicker: rec.symbol, contracts: 100, source: 'poly-activity' }), true);
  assert.strictEqual(S.L.isSniperFill({ marketTicker: rec.symbol, contracts: 37, source: 'poly-activity' }), false);
  assert.strictEqual(S.L.isSniperFill({ marketTicker: rec.symbol, contracts: 37, source: 'poly-position' }), true);
  assert.strictEqual(S.L.isSniperFill({ quoteId: 'combo-q', marketTicker: 'other' }), false);
  assert.ok(S.alerts.some((m) => /FILL/.test(m)));
});

t('REST backstop (#308 GetQuotes EXECUTED SELF) books a fill the WS missed', async () => {
  const S = await setup();
  const a = await S.post(rfq());
  const rec = S.L._internal.quotes.get(a.quoteId);
  await S.accept(a.quoteId, rec.rfqId, 100);
  S.http.executed = [{ id: a.quoteId, rfqId: rec.rfqId, status: 'QUOTE_STATUS_EXECUTED', creatorOrderId: 'ord9', buyQtyDecimal: '100' }];
  S.http.orders.ord9 = { id: 'ord9', cumQuantity: '100', state: 'ORDER_STATE_FILLED' };
  await S.L._internal.fillBackstop();
  assert.strictEqual(rec.filled, 100);
});

t('settlement books realized P&L; daily loss >= $10,000 halts and cancels', async () => {
  assert.strictEqual(comboSettlement([{ side: 'SIDE_BUY', settlementPrice: '1' }, { side: 'SIDE_SELL', settlementPrice: '0' }]), 1);
  assert.strictEqual(comboSettlement([{ side: 'SIDE_BUY', settlementPrice: '1' }, { side: 'SIDE_SELL', settlementPrice: '1' }]), 0);
  assert.strictEqual(comboSettlement([{ side: 'SIDE_BUY', settlementPrice: '1' }, { side: 'SIDE_SELL' }]), null);
  const S = await setup({ env: { POLY_SNIPER_DAILY_LOSS_CAP: '50' } });
  const resting = await S.post(rfq(ML2b));
  const a = await S.post(rfq());
  const rec = S.L._internal.quotes.get(a.quoteId);
  await S.accept(a.quoteId, rec.rfqId, 100);
  S.L._internal.bookFill(rec, { contracts: 100, fillId: 'f', isPartial: false });
  rec.settleAt = S.clock.now() - 2 * 3600e3;
  S.http.rfqs[rec.rfqId] = { comboLegs: [{ side: 'SIDE_BUY', settlementPrice: '1' }, { side: 'SIDE_SELL', settlementPrice: '0' }] };
  await S.L._internal.settleTick(); await sleep(10);
  assert.ok(S.store.patches.some(([id, p]) => id === a.quoteId && p.phase === 'settled' && p.realized_pnl < -60));
  assert.strictEqual(S.L.state(), 'daily_loss_halt');
  assert.ok(S.http.calls.del.some(([, q]) => q === resting.quoteId));
});

t('accept racing our own POST is held and routed to the sniper', async () => {
  const S = await setup();
  S.http.createQuote = async (b) => { await sleep(30); S.http.calls.create.push(b); return { quoteId: 'qrace' }; };
  const r = rfq();
  const p = S.post(r);
  await sleep(5);
  const held = S.L.onWsEvent({ type: 'quoteAccepted', quote: { id: 'qrace', rfqId: r.rfqId, acceptedSide: 'SIDE_BUY', buyQtyDecimal: '100', confirmationDeadline: new Date(S.clock.now() + 3000).toISOString() } });
  assert.strictEqual(held, true);
  await p; await sleep(5); await S.L.confirmIdle();
  assert.deepStrictEqual(S.http.calls.confirm, [[r.rfqId, 'qrace']]);
});

t('createBucket: no wait, refills', () => {
  let now = 0; const b = createBucket(2, 2, () => now);
  assert.ok(b.take() && b.take()); assert.ok(!b.take()); now = 600; assert.ok(b.take());
});

t('polymarket-rfq: sniper quote events never reach Combo Locks; reconcile filters sniper fills', async () => {
  const calls = [];
  const router = {
    onWsEvent: (evt) => { calls.push(evt.type); const q = evt.quote || {}; return q.id === 'sq1'; },
    ownsExecution: (ex) => ex.orderId === 'sord', onOrderExecution: (ex) => calls.push(`exec:${ex.orderId}`),
    isSniperFill: (e) => e.quoteId === 'sq2', onWsStall() {}, onWsRecovered() {}, onComboAcceptOutcome: (ok) => calls.push(`combo:${ok}`),
  };
  const http = { listQuotes: async () => ({ quotes: [] }), listRfqs: async () => ({ rfqs: [] }), getUserId: async () => ({}), listActivities: async () => ({}), listPositions: async () => ({}), getOrder: async (id) => ({ id, cumQuantity: '5', state: 'ORDER_STATE_FILLED' }) };
  const pendingQuotes = new Map();
  const loop = startPolymarketRfqLoop({
    env: { POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'), POLYMARKET_RFQ_LIVE: 'false' },
    http, startWs: false, enableLocks: true, enableUnhedged: false, getParlays: () => [], startedFor: () => ({ started: false }),
    filledSoFarFor: () => 0, getOutstanding: () => 0, pendingQuotes, crawl: false, reconcileMs: 1e9, fillReconcileMs: 1e9, polyHeartbeatMs: 0, sniperRouter: router,
  });
  try {
    const warned = []; const ow = console.warn; console.warn = (...a) => warned.push(a.join(' '));
    loop.onWsEvent({ type: 'quoteAccepted', quote: { id: 'sq1', rfqId: 'r1', acceptedSide: 'SIDE_BUY' } });
    loop.onWsEvent({ type: 'orderExecution', executions: [{ orderId: 'sord', type: 'EXECUTION_TYPE_FILL' }] });
    await sleep(10); console.warn = ow;
    assert.ok(calls.includes('quoteAccepted') && calls.includes('exec:sord'));
    assert.ok(!warned.some((w) => /sq1/.test(w)), 'Combo Locks must not see the sniper accept');
    // A Combo Locks quote is never offered to the sniper
    pendingQuotes.set('cq1', { rfqId: 'r2', parlayId: 'p', contracts: 1 });
    const before = calls.length;
    loop.onWsEvent({ type: 'quoteDeleted', quote: { id: 'cq1' } });
    assert.strictEqual(calls.length, before);
    pendingQuotes.delete('cq1');
    pendingQuotes.set('sq2', { rfqId: 'r3', parlayId: 'p1', contracts: 5, executed: true, creatorOrderId: 'o2' });
    pendingQuotes.set('cq3', { rfqId: 'r4', parlayId: 'p2', contracts: 5, executed: true, creatorOrderId: 'o3' });
    const booked = await loop.reconcileLockFills();
    assert.deepStrictEqual(booked.map((e) => e.quoteId), ['cq3'], 'sniper fill must be filtered out of Combo Locks reconcile');
    assert.ok(loop.confirmingQuotes instanceof Set);
  } finally { loop.stop(); }
});

t('createPolySniper DRY_RUN=0 with switch on posts through observe and logs dry_run=false', async () => {
  const rows = [];
  const supabase = { from: () => ({ insert: async (r) => { rows.push(...r); return { error: null }; } }) };
  const clock = mkClock(); const feed = fakeFeed(); const http = fakeHttp(); const store = fakeStore({ live: true });
  const s = createPolySniper({ env: { POLY_SNIPER_ENABLED: '1', POLY_SNIPER_DRY_RUN: '0' }, supabase, store, feed, log: () => {}, now: clock.now, liveTimers: false });
  await s.attachTrading({ http, comboConfirming: () => 0 });
  const d = s.observe({ rfq: rfq(ML2, '100', clock) }, 'ws');
  assert.strictEqual(d.action, 'quote');
  await sleep(20); await s.flush();
  assert.strictEqual(http.calls.create.length, 1);
  assert.ok(rows.some((r) => r.dry_run === false && r.action === 'quote'));
  await s.shutdown('test'); await sleep(10);
  assert.strictEqual(http.calls.del.length, 1);
});

t('ledger row keeps the quoted risk (quoted_risk) while counted risk stays $0 until a fill', async () => {
  const S = await setup();
  const a = await S.post(rfq(ML2, '100', S.clock));
  assert.ok(a.posted);
  const row = S.store.inserts.find((r) => r.quote_id === a.quoteId);
  assert.ok(row, 'insert row');
  assert.ok(row.quoted_risk > 0, 'quoted_risk persisted');
  assert.ok(Math.abs(row.quoted_risk - row.contracts * (1 - row.buy_price)) < 0.01, 'quoted_risk = contracts * (1 - buy)');
  assert.ok(!('risk' in row) || row.risk === 0, 'counted risk is not set on a resting quote');
});

(async () => {
  for (const [name, fn] of tests) {
    await fn(); n += 1; console.log(`ok ${name}`);
  }
  console.log(`poly-sniper live: ${n} tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
