'use strict';
// LOG-ONLY hedge-cost pricing (Kevin Nov 2 2026): per leg the best fee-included price to BUY the leg itself,
// per-venue exclusion reasons, parlay hedge prob + hedge edge (SNIPER_MIN_ROI formula). Quoting must not change.
const assert = require('assert');
const H = require('./hedge-cost');
const C = require('./hedge-cols');
const B = require('./nba');
const S = require('../auto-sniper');
const { decide, repriceHedge } = require('./engine');
const { ALL_VENUES, legFairDepth } = require('./fair');
const { createLiveSniper } = require('./live');
const { createBatchedLedgerStore } = require('./ledger-batch');
const { createLedgerStore } = require('./ledger-store');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const KF = (p) => 0.07 * p * (1 - p);
const PF = (p) => 0.0695 * p * (1 - p);

(async () => {
  // ── legHedge: cheapest usable own-side cost, one entry per venue with its exclusion reason ──
  const src = (venue, cost, reason = 'ok', extra = {}) => ({ venue, cost, reason, used: reason === 'ok', ageMs: 1000, ...extra });
  let lh = H.legHedge([src('kalshi', 0.73, 'ok', { via: 'yes_own' }), src('kalshi', 0.72, 'ok', { via: 'no_opp' }), src('novig', null, 'stale', { ageMs: 40000 }), src('prophetx', null, 'depth')], ALL_VENUES);
  assert.strictEqual(lh.v, 'kalshi'); assert.strictEqual(lh.c, 0.72); assert.strictEqual(lh.x.kalshi.via, 'no_opp');
  assert.deepStrictEqual(lh.x.novig, { r: 'stale', age: 40000 });
  assert.strictEqual(lh.x.prophetx.r, 'depth'); assert.strictEqual(lh.x.polymarket.r, 'missing');
  assert.strictEqual(lh.a, -257);
  // top-of-book-only quotes never count (same rule as the fair); venues switched off are reported, not used
  lh = H.legHedge([src('novig', 0.5, 'top_only', { used: true }), src('polymarket', 0.6)], ['kalshi', 'novig', 'prophetx']);
  assert.strictEqual(lh.c, null); assert.strictEqual(lh.x.novig.r, 'top_only'); assert.strictEqual(lh.x.polymarket.r, 'venue_off');

  // ── parlayHedge: P_h = Π c_i, edge = auto-sniper snipeEconomics with fair := P_h ──
  const legs = [{ ticker: 'A', side: 'yes', hedge: { c: 0.81, v: 'kalshi', x: {} } }, { ticker: 'B', side: 'no', hedge: { c: 0.61, v: 'novig', x: {} } }];
  const ph = H.parlayHedge(legs, { q: 0.53, n: 100, makerRate: 0.035, fair: 0.466 });
  assert.ok(near(ph.p, 0.81 * 0.61, 1e-6));
  const e = S.snipeEconomics({ fair: 0.81 * 0.61, q: 0.53, n: 100, makerRate: 0.035 });
  assert.ok(near(ph.roi, e.roi, 1e-6)); assert.ok(near(ph.ev, e.ev, 1e-4));
  assert.deepStrictEqual(ph.legs.map((l) => [l.t, l.s, l.v]), [['A', 'yes', 'kalshi'], ['B', 'no', 'novig']]);
  assert.strictEqual(ph.fair, 0.466); assert.strictEqual(ph.mr, 0.035);
  const noLeg = H.parlayHedge([legs[0], { ticker: 'B', side: 'yes', hedge: { c: null, x: {} } }], { q: 0.53, n: 100 });
  assert.strictEqual(noLeg.p, null); assert.strictEqual(noLeg.roi, null);
  const rs = H.rescoreHedge(ph, { q: 0.55, n: 40, makerRate: 0 });
  assert.ok(near(rs.roi, S.snipeEconomics({ fair: ph.p, q: 0.55, n: 40, makerRate: 0 }).roi, 1e-6)); assert.strictEqual(rs.n, 40);
  assert.deepStrictEqual(H.hedgeColumns(null), {}); assert.deepStrictEqual(Object.keys(H.hedgeColumns(ph, {})).sort(), ['hedge', 'hedge_prob', 'hedge_roi']);
  assert.deepStrictEqual(Object.keys(H.hedgeColumns(ph, { SNIPER_HEDGE_LOG: 'fills' })).sort(), ['hedge_prob', 'hedge_roi'], 'fills mode: numbers only on quotes');
  // compact per-quote form: [venue, cost, status of kalshi/polymarket/novig/prophetx]
  const full = H.parlayHedge([{ ticker: 'A', side: 'yes', hedge: H.legHedge([src('kalshi', 0.724413, 'ok', { via: 'no_opp' }), src('novig', null, 'stale'), src('prophetx', null, 'depth')], ALL_VENUES) }], { q: 0.8, n: 10, makerRate: 0.035 });
  assert.deepStrictEqual(H.compactHedge(full), { l: [['k', 0.7244, 'omsd']], m: 0.035 });
  assert.ok(JSON.stringify(H.hedgeColumns(full, {})).length < JSON.stringify(full).length / 2);
  assert.ok(H.hedgeFillColumns(ph, 0).hedge_fill.at === '1970-01-01T00:00:00.000Z');

  // ── real book (NBA ML): own side from the SAME ladders: Kalshi Yes on IND or No on DAL; Novig thin; stale after 15s ──
  let t = Date.parse('2026-10-23T20:00:00Z');
  const IND = 'KXNBAGAME-26OCT23DALIND-IND'; const DAL = 'KXNBAGAME-26OCT23DALIND-DAL'; const GID = 'nba|2026-10-23|DAL+IND';
  const book = B.createNbaBook({ now: () => t, staleMs: 15000, depthUsd: 1000 });
  book.ingestKalshiOrderbooks([
    { ticker: IND, orderbook_fp: { yes_dollars: [['0.70', '50000']], no_dollars: [['0.28', '50000']] } }, // IND Yes ask 0.72
    { ticker: DAL, orderbook_fp: { yes_dollars: [['0.29', '50000']], no_dollars: [['0.69', '50000']] } }, // DAL No ask 0.71
  ]);
  book.ingestRelay('novig', [{ bet_type: 'moneyline', away: 'Dallas Mavericks', home: 'Indiana Pacers', side: 'Indiana Pacers', odds: 0.70, depth: [{ odds: 0.70, size: 10 }], start: '2026-10-23T23:00:00Z', updated_at: new Date(t).toISOString() }], { feedLive: true, polledAt: t });
  const f = legFairDepth({ kind: 'nba', gameId: GID, team: 'IND' }, { nbaBook: book, venues: ALL_VENUES });
  const fairBefore = f.p;
  assert.strictEqual(typeof f.hedgeSources, 'function', 'fair result carries the lazy own-side reader');
  lh = H.legHedge(f.hedgeSources(), ALL_VENUES);
  assert.strictEqual(lh.v, 'kalshi'); assert.strictEqual(lh.x.kalshi.via, 'no_opp');
  assert.ok(near(lh.c, 0.71 + KF(0.71), 1e-6), JSON.stringify(lh)); // fee-included, cheaper of the two Kalshi routes
  assert.strictEqual(lh.x.novig.r, 'depth', 'Novig too thin for $1,000 => excluded with reason');
  assert.strictEqual(lh.x.polymarket.r, 'missing');
  assert.ok(lh.c > 1 - f.p, 'buying the leg costs more than the inverse fair (fees + spread count against us)');
  // Polymarket US: its own fee
  book.ingestRelay('polymarket', [{ bet_type: 'moneyline', feed: 'polymarket-us', side: 'Pacers', odds: 0.70, token_id: 'us:aec-nba-dal-ind-2026-10-23:no', start: '2026-10-23T23:00:00Z', updated_at: new Date(t).toISOString(), depth: [{ odds: 0.70, size: 100000 }] }]);
  const lp = H.legHedge(legFairDepth({ kind: 'nba', gameId: GID, team: 'IND' }, { nbaBook: book, venues: ALL_VENUES }).hedgeSources(), ALL_VENUES);
  assert.strictEqual(lp.x.polymarket.r, 'ok'); assert.ok(near(lp.x.polymarket.c, 0.70 + PF(0.70), 1e-6)); assert.strictEqual(lp.v, 'polymarket');
  t += 16000;
  const st = H.legHedge(book.legFair(GID, 'IND').hedgeSources(), ALL_VENUES);
  assert.strictEqual(st.c, null); assert.strictEqual(st.x.kalshi.r, 'stale'); assert.strictEqual(st.x.novig.r, 'stale');
  assert.ok(fairBefore > 0, 'fair unaffected');

  // ── decide(): quote identical with hedge logging on / off; hedge is non-enumerable (not in decision logs) ──
  const sTop = (venue, cost) => ({ venue, cost, reason: 'ok', used: true });
  const own = { kalshi: 0.62, novig: 0.605 };
  const pmLive = { legFair: () => ({ sources: [sTop('kalshi', 0.4), sTop('novig', 0.41)], hedgeSources: () => [sTop('kalshi', own.kalshi), sTop('novig', own.novig), { venue: 'prophetx', used: false, reason: 'stale', ageMs: 20000 }] }) };
  const config = S.sniperConfig({ SNIPER_ENABLED: '1' });
  const rfq = { rfqId: 'q1', marketTicker: 'KXMVECROSSCATEGORY0-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLGAME-26OCT25CINBAL-BAL:yes'], contracts: 20 };
  const args = () => ({ config, ledger: S.createSniperLedger(), pmLive, tdBook: null, venues: ALL_VENUES, kickoffFor: () => Date.parse('2026-10-25T17:00:00Z'), makerRate: 0.035, nowMs: Date.parse('2026-10-21T05:00:00Z') });
  const on = decide(rfq, args()).decision;
  process.env.SNIPER_HEDGE_LOG = '0';
  const offD = decide(rfq, args()).decision;
  delete process.env.SNIPER_HEDGE_LOG;
  assert.strictEqual(on.action, 'quote', JSON.stringify(on));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(on)), JSON.parse(JSON.stringify(offD)), 'quote is byte-identical with or without hedge logging');
  assert.ok(!JSON.stringify(on).includes('hedge'), 'not in sniper_decisions details');
  assert.strictEqual(offD.hedge, undefined);
  const h = on.hedge;
  assert.ok(near(h.p, 0.605 * 0.605, 1e-6)); assert.deepStrictEqual(h.legs.map((l) => l.v), ['novig', 'novig']);
  assert.strictEqual(h.legs[0].x.prophetx.r, 'stale'); assert.strictEqual(h.q, on.quoteYes); assert.strictEqual(h.n, on.contracts); assert.strictEqual(h.mr, on.makerRate);
  assert.ok(near(h.roi, S.snipeEconomics({ fair: h.p, q: on.quoteYes, n: on.contracts, makerRate: on.makerRate }).roi, 1e-6));
  assert.ok(h.roi < on.roi, 'hedge edge is below the inverse edge here');
  // a broken book reader never breaks quoting
  const bad = { legFair: () => ({ sources: [sTop('kalshi', 0.4)], hedgeSources: () => { throw new Error('boom'); } }) };
  const bd = decide(rfq, { ...args(), pmLive: bad }).decision;
  assert.strictEqual(bd.action, 'quote'); assert.strictEqual(bd.hedge, undefined);
  // fill-time re-hedge (fresh books, given price/size)
  own.novig = 0.7;
  const rh = repriceHedge(rfq, { pmLive, tdBook: null, venues: ALL_VENUES }, { q: on.quoteYes, n: 7, makerRate: 0.035 });
  assert.ok(near(rh.p, 0.62 * 0.62, 1e-6)); assert.strictEqual(rh.n, 7);

  // ── Kalshi live: hedge rides on the existing 'quoted' update and the existing fill update; nothing else changes ──
  function rig({ withHedge }) {
    const calls = []; const ops = [];
    const trader = { live: true, postQuote: async () => { calls.push('post'); return { quoteId: 'Q1', noBid: '0.419', yesBid: '0.00' }; },
      confirm: async () => { calls.push('confirm'); }, cancel: async () => { calls.push('cancel'); },
      fillsForOrder: async () => ({ reason: 'confirmed', contracts: 20, book: [{ fill_id: 'f1', count: 20, no_price: 0.419, fee: 0, ticker: 'KXMVE-X' }] }) };
    const store = { release: async (id, ph, x) => { ops.push(['release', id, ph, x]); }, update: async (id, p) => { ops.push(['update', id, p]); }, confirmCheck: async () => ({ ok: true }) };
    const L = createLiveSniper({ config: S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' }), trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.5, log: () => {}, ttlMs: 1e6, fillRetryMs: 1, sleep: async () => {},
      rehedge: withHedge ? (r, d, n) => ({ p: 0.52, roi: 0.02, n, q: d.quoteYes }) : null });
    return { L, calls, ops };
  }
  const lrfq = { rfqId: 'R1', marketTicker: 'KXMVECROSSCATEGORY0-X', legKeys: rfq.legKeys, contracts: 20, createdTs: Date.now() };
  const mk = () => { const d = { rfqId: 'R1', quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8.38 }; return d; };
  const runs = [];
  for (const withHedge of [true, false]) {
    const r = rig({ withHedge }); const d = mk();
    if (withHedge) Object.defineProperty(d, 'hedge', { value: { p: 0.51, roi: 0.03, legs: [] }, enumerable: false });
    await r.L.send(lrfq, d);
    await r.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'no', contractsAccepted: 20 });
    await r.L.onExecuted({ quoteId: 'Q1', orderId: 'O1' });
    runs.push(r);
  }
  const [wh, nh] = runs;
  assert.deepStrictEqual(wh.calls, nh.calls); assert.deepStrictEqual(wh.calls, ['post', 'confirm']);
  assert.strictEqual(wh.ops.length, nh.ops.length, 'no extra ledger writes');
  const quoted = wh.ops.find((o) => o[0] === 'update' && o[2].phase === 'quoted')[2];
  assert.deepStrictEqual(quoted.hedge, { l: [], m: 0 }); assert.strictEqual(quoted.hedge_prob, 0.51); assert.strictEqual(quoted.hedge_roi, 0.03);
  const filled = wh.ops.find((o) => o[0] === 'update' && o[2].phase === 'filled')[2];
  assert.strictEqual(filled.hedge_fill.p, 0.52); assert.strictEqual(filled.hedge_fill.n, 20); assert.ok(filled.hedge_fill.at);
  const strip = (ops) => ops.map((o) => (o[2] && typeof o[2] === 'object' ? [o[0], o[1], C.stripHedgeCols(o[2]), o[3]] : o));
  assert.deepStrictEqual(strip(wh.ops), strip(nh.ops), 'same ledger writes apart from the hedge fields');
  assert.ok(!('hedge' in nh.ops.find((o) => o[2] && o[2].phase === 'quoted')[2]));

  // ── missing columns (migration not run): drop them once, keep the row ──
  C._resetHedgeCols();
  const isMissing = { message: "Could not find the 'hedge' column of 'sniper_ledger' in the schema cache" };
  assert.ok(C.isMissingHedgeCol(isMissing)); assert.ok(!C.isMissingHedgeCol({ message: 'duplicate key value violates unique constraint' }));
  const writes = [];
  const res = await C.writeTolerant('t1', { a: 1, hedge: {}, hedge_roi: 0.1 }, async (o) => { writes.push(o); return 'hedge' in o ? { error: isMissing } : { error: null }; }, () => {});
  assert.strictEqual(res.error, null); assert.deepStrictEqual(writes[1], { a: 1 });
  assert.strictEqual(C.hedgeColsOn('t1'), false); assert.deepStrictEqual(C.forTable('t1', { a: 2, hedge_fill: {} }), { a: 2 });
  assert.strictEqual(C.hedgeColsOn('t2'), true, 'per table');

  // ledger-store.update (write-behind / direct path)
  C._resetHedgeCols();
  const upd = [];
  const sb1 = { from: () => ({ update: (p) => ({ eq: async () => { upd.push(p); return 'hedge' in p ? { error: isMissing } : { error: null }; } }) }) };
  const ls = createLedgerStore({ supabase: sb1, log: () => {} });
  assert.strictEqual(await ls.update('R1', { phase: 'quoted', quote_id: 'Q', hedge: { p: 1 }, hedge_prob: 1, hedge_roi: 0 }), true);
  assert.strictEqual(upd.length, 2); assert.strictEqual(upd[1].phase, 'quoted'); assert.ok(!('hedge' in upd[1]));
  assert.strictEqual(await ls.update('R1', { phase: 'filled', hedge_fill: {} }), true); assert.strictEqual(upd.length, 3, 'known missing => stripped up front, no failed write');

  // batched ledger (default live path): insert row merged with the 'quoted' patch
  C._resetHedgeCols();
  const ups = []; const ups2 = [];
  const sb2 = { from: () => ({
    upsert: async (rows) => { ups.push(rows); return rows.some((r) => 'hedge' in r) ? { error: isMissing } : { error: null }; },
    update: (p) => ({ in: async () => { ups2.push(p); return 'hedge_fill' in p ? { error: { message: 'column "hedge_fill" of relation "sniper_ledger" does not exist' } } : { error: null }; } }),
  }) };
  const bs = createBatchedLedgerStore({}, { supabase: sb2, flushMs: 5, log: () => {} });
  const dd = { rfqId: 'RB', combo: 'x', games: [], legs: [], risk: 1, ev: 0, roi: 0, quoteYes: 0.5, contracts: 1, releaseAt: Date.now() + 1e6 };
  assert.ok(bs.reserve(dd, { releaseAt: Date.now() + 1e6, dryRun: false }).ok);
  const ok1 = await bs.update('RB', { phase: 'quoted', quote_id: 'Q', hedge: { p: 0.5 }, hedge_prob: 0.5, hedge_roi: 0.01 });
  assert.strictEqual(ok1, true); assert.strictEqual(ups.length, 2); assert.strictEqual(ups[1][0].phase, 'quoted'); assert.ok(!('hedge' in ups[1][0]));
  C._resetHedgeCols();
  const ok2 = await bs.update('RB', { phase: 'filled', hedge_fill: { p: 1 } });
  assert.strictEqual(ok2, true); assert.strictEqual(ups2.length, 2); assert.deepStrictEqual(Object.keys(ups2[1]).sort(), ['phase', 'updated_at']);

  console.log('sniper/hedge-cost.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
