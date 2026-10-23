'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createPolySniper } = require('./index');
const { decidePoly, polySniperConfig, createVenueLedger } = require('./engine');
const { createKalshiIndex } = require('./map');
const { fairVenues } = require('./feed');
const { assertNoTradingClient } = require('./guard');
const { DEFAULT_PAGE_DELAY_MS } = require('../poly-intake');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`ok ${name}`); };
const NOW = Date.parse('2026-10-24T16:00:00Z');

function fakeFeed({ cost = 0.45, kickoffMs = Date.parse('2026-10-25T17:00:00Z'), healthy = true } = {}) {
  const index = createKalshiIndex();
  index.ingestMarkets(['PHIWAS-PHI', 'PHIWAS-WAS', 'NYGDEN-NYG', 'NYGDEN-DEN', 'BUFNYJ-BUF', 'BUFNYJ-NYJ'].map((x) => ({ ticker: `KXNFLGAME-26OCT25${x}` })));
  return {
    index, venues: fairVenues({}), pricesHealthy: () => healthy, tdBook: null, ncaafBook: null,
    kickoffs: { kickoffFor: () => kickoffMs },
    pmLive: { legFair: () => ({ sources: [{ venue: 'novig', used: true, reason: 'ok', cost, availUsd: 2500 }, { venue: 'polymarket', used: true, reason: 'ok', cost: 0.30 }] }) },
  };
}
const rfq = (legs, extra = {}) => ({ rfqId: `rfq_${Math.random()}`, symbol: 'crossd-x', qtyDecimal: '100', tickSize: 0.001, createdTime: new Date(NOW - 50).toISOString(), comboLegs: legs, ...extra });
const ML2 = [{ symbol: 'aec-nfl-phi-was-2026-10-25', side: 'SIDE_BUY' }, { symbol: 'aec-nfl-nyg-den-2026-10-25', side: 'SIDE_SELL' }];

t('NFL ML combo: quotes at >= 3% edge, sell side off, Polymarket book excluded from fair', () => {
  const d = decidePoly(rfq(ML2), { feed: fakeFeed(), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(d.action, 'quote', d.reason);
  assert.strictEqual(d.sellPrice, '0');
  assert.ok(Math.abs(d.fair - 0.55 * 0.55) < 1e-9, `fair ${d.fair}`); // novig 0.45 cost, not polymarket 0.30
  assert.ok(d.roi >= 0.03 - 1e-9 && d.buyPrice > d.fair);
  assert.strictEqual(d.minRoi, 0.03);
  assert.deepStrictEqual(d.legs.map((l) => l.venue), ['novig', 'novig']);
});

t('fair venues exclude polymarket by default; opt-in includes it', () => {
  assert.deepStrictEqual(fairVenues({}), ['kalshi', 'novig', 'prophetx']);
  assert.ok(fairVenues({ POLY_SNIPER_FAIR_INCLUDE_POLY: '1' }).includes('polymarket'));
});

t('no quoting inside 30 min of kickoff / after kickoff', () => {
  const d = decidePoly(rfq(ML2), { feed: fakeFeed({ kickoffMs: NOW + 10 * 60000 }), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(d.reason, 'game_started');
  const d2 = decidePoly(rfq(ML2), { feed: fakeFeed({ kickoffMs: null }), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW });
  assert.strictEqual(d2.reason, 'no_kickoff');
});

t('stale prices, unmapped legs, spreads/totals skip', () => {
  assert.strictEqual(decidePoly(rfq(ML2), { feed: fakeFeed({ healthy: false }), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW }).reason, 'prices_stale');
  const un = [ML2[0], { symbol: 'aec-nfl-sf-kc-2026-10-25', side: 'SIDE_BUY' }];
  assert.strictEqual(decidePoly(rfq(un), { feed: fakeFeed(), config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: NOW }).reason, 'unmapped_leg');
});

t('per-venue game cap uses the Polymarket ledger only', () => {
  const config = polySniperConfig({ POLY_SNIPER_PER_GAME_CAP: '100' });
  const ledger = createVenueLedger('polymarket');
  const a = decidePoly(rfq(ML2), { feed: fakeFeed(), config, ledger, nowMs: NOW });
  assert.strictEqual(a.action, 'quote');
  const other = [ML2[0], { symbol: 'aec-nfl-buf-nyj-2026-10-25', side: 'SIDE_BUY' }];
  const b = decidePoly(rfq(other), { feed: fakeFeed(), config, ledger, nowMs: NOW });
  assert.strictEqual(b.reason, 'game_cap');
  assert.strictEqual(ledger.venue, 'polymarket');
});

t('dry-run gate enforced in code', () => {
  assert.strictEqual(createPolySniper({ env: {} }), null);
  assert.throws(() => createPolySniper({ env: { POLY_SNIPER_ENABLED: '1' } }), /DRY_RUN must be exactly 1/);
  assert.throws(() => createPolySniper({ env: { POLY_SNIPER_ENABLED: '1', POLY_SNIPER_DRY_RUN: '0' } }), /DRY_RUN/);
  assert.throws(() => assertNoTradingClient({ http: { createQuote() {} } }), /trading clients are not allowed/);
  assert.throws(() => createPolySniper({ env: { POLY_SNIPER_ENABLED: '1', POLY_SNIPER_DRY_RUN: '1' }, feed: { ...fakeFeed(), confirmQuote() {} } }), /confirmQuote/);
});

t('observe logs a hypothetical decision with latency', () => {
  const rows = [];
  const supabase = { from: () => ({ insert: async (r) => { rows.push(...r); return { error: null }; } }) };
  const s = createPolySniper({ env: { POLY_SNIPER_ENABLED: '1', POLY_SNIPER_DRY_RUN: '1' }, supabase, feed: fakeFeed(), log: () => {}, now: () => NOW });
  const d = s.observe({ rfq: rfq(ML2) }, 'ws');
  assert.strictEqual(d.action, 'quote');
  return s.flush().then(() => {
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].dry_run, true); assert.strictEqual(rows[0].venue, 'polymarket');
    assert.strictEqual(rows[0].rfq_age_ms, 50); assert.strictEqual(rows[0].within_target, true);
  });
});

t('poly-sniper source never references quote/confirm/delete endpoints or the Polymarket client', () => {
  for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/\/v1\/rfqs\/quotes|\/confirm|\.createQuote\(|\.confirmQuote\(|\.deleteQuote\(|polymarket-client|POLYMARKET_SECRET|POLYMARKET_KEY_ID/.test(src), `${f} references trading`);
  }
});

t('RFQ crawl pages at <= 1 req/s by default', () => { assert.ok(DEFAULT_PAGE_DELAY_MS >= 1000); });

console.log(`poly-sniper: ${n} tests passed`);
