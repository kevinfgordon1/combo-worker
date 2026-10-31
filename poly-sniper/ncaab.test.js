'use strict';
// Polymarket sniper: men's college basketball MONEYLINES (Kevin Oct 30) — switch OFF by default
// (POLY_SNIPER_NCAAB=1), D1 vs D1 only, 6% NCAAB-only minimum, 24h tip horizon (never > 36h).
const assert = require('assert');
const { decidePoly, polySniperConfig, polyMinRoi, createVenueLedger } = require('./engine');
const { createKalshiIndex, mapPolyLegs, kalshiIdentity } = require('./map');
const { fairVenues } = require('./feed');
const L = require('../leg-identity');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`ok ${name}`); };
const NOW = Date.parse('2026-11-01T06:00:00Z');
const KALSHI = [
  { ticker: 'KXNCAAMBGAME-26NOV01NDVILL-VILL', yes_sub_title: 'Villanova' }, { ticker: 'KXNCAAMBGAME-26NOV01NDVILL-ND', yes_sub_title: 'Notre Dame' },
  { ticker: 'KXNCAAMBGAME-26NOV02LIBHP-LIB', yes_sub_title: 'Liberty' }, { ticker: 'KXNCAAMBGAME-26NOV02LIBHP-HP', yes_sub_title: 'High Point' },
  { ticker: 'KXNCAAMBGAME-26NOV02FISKBEL-BEL', yes_sub_title: 'Belmont' }, // vs non-D1 Fisk: never indexed
  { ticker: 'KXNCAAMBSPREAD-26NOV01NDVILL-VILL5', floor_strike: 4.5, strike_type: 'greater' },
  { ticker: 'KXNFLGAME-26NOV01BUFKC-BUF' }, { ticker: 'KXNFLGAME-26NOV01BUFKC-KC' },
];
const index = () => { const i = createKalshiIndex(); i.ingestMarkets(KALSHI); return i; };
const ON = { leagues: ['nfl', 'ncaaf', 'nba', 'ncaab'] };
const BUY = 'SIDE_BUY'; const SELL = 'SIDE_SELL';
const ML = [{ symbol: 'aec-cbb-vill-nd-2026-11-01', side: BUY }, { symbol: 'aec-cbb-hpnt-librty-2026-11-02', side: SELL }];
function fakeFeed({ kickoffMs = NOW + 10 * 3600e3, ncaab = true } = {}) {
  return {
    index: index(), venues: fairVenues({ POLY_SNIPER_FAIR_INCLUDE_POLY: '0' }), pricesHealthy: () => true, tdBook: null, ncaafBook: null, nbaBook: null, linesBook: null,
    kickoffs: { kickoffFor: () => kickoffMs },
    pmLive: { legFair: () => ({ sources: [] }) },
    ncaabBook: ncaab ? { legFair: () => ({ sources: [{ venue: 'novig', used: true, reason: 'ok', cost: 0.5, availUsd: 5000 }] }) } : null,
  };
}
const rfq = (legs) => ({ rfqId: `rfq_${Math.random()}`, symbol: 'crossd-x', qtyDecimal: '100', tickSize: 0.001, createdTime: new Date(NOW - 50).toISOString(), comboLegs: legs });

t('Kalshi D1 tickers index; non-D1 and spreads never map as moneylines', () => {
  assert.ok(kalshiIdentity('KXNCAAMBGAME-26NOV01NDVILL-VILL', 'Villanova'));
  assert.strictEqual(kalshiIdentity('KXNCAAMBGAME-26NOV01NDVILL-VILL', 'Notre Dame'), null, 'label must match the code');
  assert.strictEqual(kalshiIdentity('KXNCAAMBGAME-26NOV02FISKBEL-BEL', 'Belmont'), null, 'non-D1 opponent');
  assert.strictEqual(L.parseKalshiTicker('KXNCAAMBGAME-26NOV01NDVILL-VILL:yes'), null, 'Combo Locks parser unchanged');
  const k = L.identityKey(kalshiIdentity('KXNCAAMBGAME-26NOV01NDVILL-VILL', 'Villanova'));
  const p = L.identityKey(L.identityFromPolymarketSlug('aec-cbb-vill-nd-2026-11-01', 'yes'));
  assert.strictEqual(k, p, 'Kalshi and Polymarket identities agree');
  assert.strictEqual(L.identityFromPolymarketSlug('aec-cbb-fisk-bel-2026-11-02', 'yes'), null, 'unknown/non-D1 slug => no identity');
});

t('Poly cbb ML legs map to the right Kalshi ticker + side (BUY = first slug team, SELL = the other)', () => {
  const m = mapPolyLegs(ML, index(), ON);
  assert.ok(m.ok, JSON.stringify(m));
  assert.deepStrictEqual(m.legKeys, ['KXNCAAMBGAME-26NOV01NDVILL-VILL:yes', 'KXNCAAMBGAME-26NOV02LIBHP-LIB:yes']);
  assert.strictEqual(mapPolyLegs(ML, index(), { leagues: ['nfl', 'ncaaf', 'nba'] }).reason, 'scope_ncaab', 'off => out of scope');
});

t('OFF by default: config, mapping scope and decide all skip', () => {
  const c = polySniperConfig({});
  assert.strictEqual(c.ncaab, false); assert.strictEqual(c.minRoiNcaab, 0.06); assert.strictEqual(c.ncaabHours, 24);
  assert.strictEqual(polySniperConfig({ POLY_SNIPER_NCAAB_HOURS: '72' }).ncaabHours, 36, 'hard cap 36h');
  // other minimums untouched
  assert.strictEqual(c.minRoiNflMl, 0.05); assert.strictEqual(c.minRoiNfl, 0.05); assert.strictEqual(c.minRoiNcaaf, 0.05); assert.strictEqual(c.minRoiNba, 0.06); assert.strictEqual(c.minRoiTd, 0.06);
  assert.strictEqual(c.maxRisk, 500); assert.strictEqual(c.perLegCap, 1000);
  const d = decidePoly(rfq(ML), { feed: fakeFeed(), config: c, ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(d.reason, 'scope_ncaab');
});

t('ON: quotes at >= 6% edge; horizon, lines and caps enforced', () => {
  const c = polySniperConfig({ POLY_SNIPER_NCAAB: '1' });
  const d = decidePoly(rfq(ML), { feed: fakeFeed(), config: c, ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(d.action, 'quote', JSON.stringify(d)); assert.strictEqual(d.minRoi, 0.06);
  assert.ok(d.roi >= 0.06 - 1e-9 && d.risk <= 500 + 1e-9, JSON.stringify(d));
  assert.ok(d.legs.every((l) => l.kind === 'ncaab'));
  assert.strictEqual(polyMinRoi([{ kind: 'ncaab' }, { kind: 'ml' }], c), 0.06);
  assert.strictEqual(polyMinRoi([{ kind: 'ml' }, { kind: 'ml' }], c), 0.05, 'NFL ML rule unchanged');
  assert.strictEqual(decidePoly(rfq(ML), { feed: fakeFeed({ kickoffMs: NOW + 30 * 3600e3 }), config: c, ledger: createVenueLedger(), nowMs: NOW }).reason, 'ncaab_beyond_horizon');
  assert.strictEqual(decidePoly(rfq(ML), { feed: fakeFeed({ ncaab: false }), config: c, ledger: createVenueLedger(), nowMs: NOW }).reason, 'scope_ncaab', 'no book => off');
  const hi = polySniperConfig({ POLY_SNIPER_NCAAB: '1', POLY_SNIPER_MIN_ROI_NCAAB: '5' });
  assert.ok(/^roi_/.test(decidePoly(rfq(ML), { feed: fakeFeed(), config: hi, ledger: createVenueLedger(), nowMs: NOW }).reason));
});
console.log(`poly-sniper/ncaab.test.js ok (${n})`);
