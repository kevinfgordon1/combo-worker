'use strict';
// Polymarket sniper DRY RUN: NBA (ML + spreads/totals) and main spreads/totals (Kevin Oct 28).
// Poly line legs map to the ONE Kalshi strike + side with the exact same identity, both ways verified:
// Kalshi floor_strike/strike_type and REAL Polymarket gateway metadata (../fixtures-poly-aliases.json).
process.env.POLY_NBA_LINES = '1'; // poly-worker sets this (start-poly.js)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decidePoly, polySniperConfig, polyMinRoi, createVenueLedger } = require('./engine');
const { createKalshiIndex, mapPolyLegs, kalshiLineEntries } = require('./map');
const { createLineMetaCache, fairVenues } = require('./feed');
const { createPolySniper } = require('./index');

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures-poly-aliases.json'), 'utf8'));
let n = 0;
const t = (name, fn) => { const r = fn(); n += 1; console.log(`ok ${name}`); return r; };
const BUY = 'SIDE_BUY'; const SELL = 'SIDE_SELL';
const NOW = Date.parse('2026-10-27T18:00:00Z'); // SAC @ SAS tips 2026-10-28T00:00Z
const TIP = Date.parse('2026-10-28T00:00:00Z');

// Kalshi markets as the public API lists them (floor_strike / strike_type are the venue's own metadata).
const KALSHI = [
  { ticker: 'KXNBAGAME-26OCT27SACSAS-SAS' }, { ticker: 'KXNBAGAME-26OCT27SACSAS-SAC' },
  { ticker: 'KXNBAGAME-26OCT27DETNYK-NYK' }, { ticker: 'KXNBAGAME-26OCT27DETNYK-DET' },
  { ticker: 'KXNBASPREAD-26OCT27SACSAS-SAS19', floor_strike: 18.5, strike_type: 'greater' },
  { ticker: 'KXNBATOTAL-26OCT27SACSAS-233', floor_strike: 232.5, strike_type: 'greater' },
  { ticker: 'KXNFLGAME-26NOV01CHIWAS-CHI' }, { ticker: 'KXNFLGAME-26NOV01CHIWAS-WAS' },
  { ticker: 'KXNCAAFSPREAD-26OCT24KSUASU-KSU2', floor_strike: 1.5, strike_type: 'greater' },
  { ticker: 'KXNCAAFTOTAL-26OCT24KSUASU-52', floor_strike: 51.5, strike_type: 'greater' },
];
const index = () => { const i = createKalshiIndex(); i.ingestMarkets(KALSHI); return i; };
const metaOf = (extra = {}) => {
  const wanted = [];
  return { wanted, get: (s) => (s in extra ? extra[s] : FX.markets[s]), want: (s) => wanted.push(s) };
};
const legs = (...xs) => xs.map(([symbol, side]) => ({ symbol, side }));
const ALL = { leagues: ['nfl', 'ncaaf', 'nba'] };

t('Kalshi strike is indexed only when its own metadata proves the line', () => {
  assert.strictEqual(kalshiLineEntries({ ticker: 'KXNBASPREAD-26OCT27SACSAS-SAS19', floor_strike: 18.5, strike_type: 'greater' }).length, 2);
  assert.strictEqual(kalshiLineEntries({ ticker: 'KXNBASPREAD-26OCT27SACSAS-SAS19', floor_strike: 19, strike_type: 'greater' }).length, 0);
  assert.strictEqual(kalshiLineEntries({ ticker: 'KXNBASPREAD-26OCT27SACSAS-SAS19', floor_strike: 18.5, strike_type: 'less' }).length, 0);
  assert.strictEqual(kalshiLineEntries({ ticker: 'KXNBASPREAD-26OCT27SACSAS-SAS19' }).length, 0);
  assert.strictEqual(kalshiLineEntries({ ticker: 'KXNBATOTAL-26OCT27SACSAS-233', floor_strike: 232.5, strike_type: 'greater' }).length, 2);
  const i = index();
  assert.strictEqual(i.lineStats().indexed, 4);
  assert.strictEqual(i.lineStats().rejected, 0);
});

t('Poly spread/total/ML legs map to the exact Kalshi strike + side (real Polymarket metadata)', () => {
  const i = index(); const lineMeta = metaOf();
  // SELL asc-nba-sac-sa-…-pos-18pt5 = short "SAC +18.5" = SAS −18.5 = Kalshi SAS19 Yes
  let m = mapPolyLegs(legs(['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL], ['aec-nba-det-ny-2026-10-27', SELL]), i, { ...ALL, lineMeta });
  assert.ok(m.ok, m.reason);
  assert.deepStrictEqual(m.legKeys, ['KXNBASPREAD-26OCT27SACSAS-SAS19:yes', 'KXNBAGAME-26OCT27DETNYK-NYK:yes']);
  // BUY = SAC +18.5 = Kalshi SAS19 No
  m = mapPolyLegs(legs(['asc-nba-sac-sa-2026-10-27-pos-18pt5', BUY], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta });
  assert.deepStrictEqual(m.legKeys, ['KXNBASPREAD-26OCT27SACSAS-SAS19:no', 'KXNBAGAME-26OCT27DETNYK-DET:yes']);
  // totals: BUY = Over 232.5 = Kalshi 233 Yes; SELL = Under = 233 No
  m = mapPolyLegs(legs(['tsc-nba-sac-sa-2026-10-27-232pt5', SELL], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta });
  assert.strictEqual(m.legKeys[0], 'KXNBATOTAL-26OCT27SACSAS-233:no');
  m = mapPolyLegs(legs(['tsc-nba-sac-sa-2026-10-27-232pt5', BUY], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta });
  assert.strictEqual(m.legKeys[0], 'KXNBATOTAL-26OCT27SACSAS-233:yes');
  // Spurs ML: Poly `sa` == Kalshi SAS
  m = mapPolyLegs(legs(['aec-nba-sac-sa-2026-10-27', SELL], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta });
  assert.strictEqual(m.legKeys[0], 'KXNBAGAME-26OCT27SACSAS-SAS:yes');
  // college lines (K-State renamed on Polymarket): SELL K-State −1.5 = ASU +1.5 = Kalshi KSU2 No
  m = mapPolyLegs(legs(['asc-cfb-kanst-arzst-2026-10-24-neg-1pt5', SELL], ['tsc-cfb-kanst-arzst-2026-10-24-total-51pt5', SELL]), i, { ...ALL, lineMeta });
  assert.deepStrictEqual(m.legKeys, ['KXNCAAFSPREAD-26OCT24KSUASU-KSU2:no', 'KXNCAAFTOTAL-26OCT24KSUASU-52:no']);
});

t('exact line only, fail closed', () => {
  const i = index();
  // a different number (SAC +1.5) has no Kalshi strike indexed => unmapped, never the nearest line
  let m = mapPolyLegs(legs(['asc-nba-sac-sa-2026-10-27-pos-1pt5', BUY], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta: metaOf() });
  assert.strictEqual(m.reason, 'unmapped_leg');
  // metadata not fetched yet => pending + fetch requested; fetched but unusable => missing
  const pend = metaOf({ 'asc-nba-sac-sa-2026-10-27-pos-18pt5': undefined });
  m = mapPolyLegs(legs(['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta: pend });
  assert.strictEqual(m.reason, 'line_meta_pending');
  assert.deepStrictEqual(pend.wanted, ['asc-nba-sac-sa-2026-10-27-pos-18pt5']);
  m = mapPolyLegs(legs(['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta: metaOf({ 'asc-nba-sac-sa-2026-10-27-pos-18pt5': null }) });
  assert.strictEqual(m.reason, 'line_meta_missing');
  // metadata that disagrees with the slug (wrong line) => rejected
  const bad = JSON.parse(JSON.stringify(FX.markets['asc-nba-sac-sa-2026-10-27-pos-18pt5'])); bad.line = 17.5;
  m = mapPolyLegs(legs(['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL], ['aec-nba-det-ny-2026-10-27', BUY]), i, { ...ALL, lineMeta: metaOf({ 'asc-nba-sac-sa-2026-10-27-pos-18pt5': bad }) });
  assert.ok(/^line_/.test(m.reason) && m.reason !== 'line_meta_pending', m.reason);
  // no lineMeta (lines off) => old behaviour
  m = mapPolyLegs(legs(['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL], ['aec-nba-det-ny-2026-10-27', BUY]), i, ALL);
  assert.strictEqual(m.reason, 'scope_spread_total');
  // NBA off => scope_nba
  m = mapPolyLegs(legs(['aec-nba-sac-sa-2026-10-27', SELL], ['aec-nba-det-ny-2026-10-27', BUY]), i, {});
  assert.strictEqual(m.reason, 'scope_nba');
});

const src = (cost) => ({ sources: [{ venue: 'novig', used: true, reason: 'ok', cost, availUsd: 2500 }, { venue: 'polymarket', used: true, reason: 'ok', cost: cost + 0.01, availUsd: 2500 }] });
function fakeFeed({ kickoffMs = TIP, cost = 0.45 } = {}) {
  return {
    index: index(), venues: fairVenues({}), pricesHealthy: () => true, tdBook: null, ncaafBook: null,
    kickoffs: { kickoffFor: () => kickoffMs },
    pmLive: { legFair: () => src(cost) },
    nbaBook: { legFair: () => src(cost) },
    linesBook: { legFair: () => ({ p: 1 - cost, ...src(cost) }) },
    lineMeta: metaOf(),
  };
}
const rfq = (ls) => ({ rfqId: `rfq_${Math.random()}`, symbol: 'caoc-x', qtyDecimal: '100', tickSize: 0.001, createdTime: new Date(NOW - 50).toISOString(), comboLegs: legs(...ls) });
const NBA2 = [['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL], ['aec-nba-det-ny-2026-10-27', SELL]];

t('NBA spread + NBA ML combo: priced by the sniper books, 6% NBA minimum edge, sell side off', () => {
  const d = decidePoly(rfq(NBA2), { feed: fakeFeed(), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(d.action, 'quote', d.reason);
  assert.strictEqual(d.minRoi, 0.06);
  assert.ok(d.roi >= 0.06 - 1e-9);
  assert.strictEqual(d.sellPrice, '0');
  assert.deepStrictEqual(d.legs.map((l) => [l.ticker, l.side, l.kind, l.league]), [
    ['KXNBASPREAD-26OCT27SACSAS-SAS19', 'yes', 'line', 'nba'], ['KXNBAGAME-26OCT27DETNYK-NYK', 'yes', 'nba', null],
  ]);
});

t('NBA horizon, kickoff buffer, and scope switches', () => {
  const far = decidePoly(rfq(NBA2), { feed: fakeFeed({ kickoffMs: NOW + 40 * 3600e3 }), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(far.reason, 'nba_beyond_horizon');
  const late = decidePoly(rfq(NBA2), { feed: fakeFeed({ kickoffMs: NOW + 10 * 60000 }), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(late.reason, 'game_started');
  const noNba = decidePoly(rfq(NBA2), { feed: fakeFeed(), config: polySniperConfig({ POLY_SNIPER_NBA: '0' }), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(noNba.reason, 'scope_nba'); // NBA off: NBA spread legs stay out too
  const noLines = decidePoly(rfq([['asc-nba-sac-sa-2026-10-27-pos-18pt5', SELL], ['aec-nba-det-ny-2026-10-27', SELL]]), { feed: fakeFeed(), config: polySniperConfig({ POLY_SNIPER_LINES: '0' }), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(noLines.reason, 'scope_spread_total');
  const below = decidePoly(rfq(NBA2), { feed: fakeFeed({ cost: 0.45 }), config: polySniperConfig({ POLY_SNIPER_MAX_ROI: '0.05' }), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(below.reason, 'roi_suspicious'); // 6% floor still applied before the max-edge sanity cap
});

t('min edge: NBA 6% (highest rule wins); existing NFL / college / TD rules unchanged', () => {
  const c = polySniperConfig({});
  assert.strictEqual(c.minRoiNflMl, 0.03); assert.strictEqual(c.minRoiNfl, 0.04);
  assert.strictEqual(c.minRoiNcaaf, 0.05); assert.strictEqual(c.minRoiTd, 0.06); assert.strictEqual(c.minRoiNba, 0.06);
  assert.strictEqual(polyMinRoi([{ kind: 'ml' }, { kind: 'nba' }], c), 0.06);
  assert.strictEqual(polyMinRoi([{ kind: 'ml' }, { kind: 'line', league: 'nba' }], c), 0.06);
  assert.strictEqual(polyMinRoi([{ kind: 'ml' }, { kind: 'line', league: 'nfl' }], c), 0.04);
  assert.strictEqual(polyMinRoi([{ kind: 'ml' }, { kind: 'line', league: 'ncaaf' }], c), 0.05);
  assert.strictEqual(polySniperConfig({ POLY_SNIPER_MIN_ROI_NBA: '0.08' }).minRoiNba, 0.08);
});

t('still dry run only: no live mode, no trading client', () => {
  assert.throws(() => createPolySniper({ env: { POLY_SNIPER_ENABLED: '1', POLY_SNIPER_DRY_RUN: '0' } }), /DRY_RUN/);
  assert.throws(() => createPolySniper({ env: { POLY_SNIPER_ENABLED: '1', POLY_SNIPER_DRY_RUN: '1' }, feed: { ...fakeFeed(), createQuote() {} } }), /createQuote/);
});

(async () => {
  // gateway metadata cache: lazy fetch, 404 => null, bounded queue, TTL
  let clock = 0; const calls = [];
  const c = createLineMetaCache({ now: () => clock, maxQueue: 2, ttlMs: 1000, missTtlMs: 500, fetchMarket: async (s) => { calls.push(s); return s.endsWith('missing') ? null : { slug: s }; } });
  assert.strictEqual(c.get('a'), undefined);
  c.want('a'); c.want('a'); c.want('b-missing'); c.want('c'); c.want('d');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(c.get('a'), { slug: 'a' });
  assert.strictEqual(c.get('b-missing'), null);
  assert.ok(calls.filter((x) => x === 'a').length === 1, 'deduped');
  assert.ok(c.stats().dropped >= 1, 'queue bounded');
  clock = 600; assert.strictEqual(c.get('b-missing'), undefined, 'miss expires');
  clock = 1200; assert.strictEqual(c.get('a'), undefined, 'hit expires');
  n += 1; console.log('ok line metadata cache');
  console.log(`poly-sniper nba-lines: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
