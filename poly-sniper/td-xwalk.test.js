'use strict';
// NFL anytime-TD legs on the Polymarket sniper: live player crosswalk -> Kalshi index -> mapper.
const assert = require('assert');
const PROPX = require('../player-prop-crosswalk');
const { createKalshiIndex, mapPolyLegs } = require('./map');
const { fetchLiveTdCrosswalk } = require('./prop-xwalk');
const { createDecisionLogger, legRows } = require('./index');
const { decidePoly, polySniperConfig, createVenueLedger } = require('./engine');
const { fairVenues } = require('./feed');

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const EV = 'KXNFLTD-26OCT25PITNO';
const kalshiEvents = { events: [{ event_ticker: EV, markets: [
  { ticker: `${EV}-NONFANT87-1`, yes_sub_title: 'Noah Fant: 1+' },
  { ticker: `${EV}-NONFANT87-2`, yes_sub_title: 'Noah Fant: 2+' },
  { ticker: `${EV}-PITDKMETCALF14-1`, yes_sub_title: 'DK Metcalf: 1+' },
] }] };
const polyMk = (abbr, name, teamId, line) => ({ slug: `astatc-nfl-pit-no-2026-10-25-td-${abbr}-gte${line}`, sportsMarketType: 'football_player_touchdowns', line, gameStartTime: '2026-10-25T17:00:00Z', metadata: { playerName: name, playerAbbreviation: abbr, playerId: abbr === 'noafan' ? 11 : 12, teamId } });
const polyEvent = { event: { slug: 'nfl-pit-no-2026-10-25', startTime: '2026-10-25T17:00:00Z', teams: [{ id: 1, abbreviation: 'PIT' }, { id: 2, abbreviation: 'NO' }],
  markets: [polyMk('noafan', 'Noah Fant', 2, 1), polyMk('noafan', 'Noah Fant', 2, 2), polyMk('dkmet', 'DK Metcalf', 1, 1)] } };
const fakeGet = async (u) => {
  if (/kalshi\.com.*events\?/.test(u)) return kalshiEvents;
  if (/v2\/leagues\/nfl\/events/.test(u)) return { events: [{ slug: 'nfl-pit-no-2026-10-25' }] };
  if (/v1\/events\/slug\//.test(u)) return polyEvent;
  throw new Error(`unexpected ${u}`);
};
const kalshiMarkets = kalshiEvents.events[0].markets;

t('before: checked-in snapshot crosswalk indexes 0 of this week\'s TD markets', async () => {
  const idx = createKalshiIndex(); idx.ingestMarkets(kalshiMarkets);
  assert.deepStrictEqual(idx.tdStats(), { seen: 3, indexed: 0 });
  const r = mapPolyLegs([{ symbol: 'astatc-nfl-pit-no-2026-10-25-td-noafan-gte1', side: 'SIDE_BUY' }, { symbol: 'astatc-nfl-pit-no-2026-10-25-td-dkmet-gte1', side: 'SIDE_BUY' }], idx);
  assert.strictEqual(r.reason, 'unmapped_leg');
});

t('live crosswalk (public GETs only) maps Yes and No TD legs to the exact Kalshi ticker', async () => {
  const xw = await fetchLiveTdCrosswalk(fakeGet);
  assert.strictEqual(xw.players.length, 2);
  const idx = createKalshiIndex(); idx.ingestMarkets(kalshiMarkets); idx.setPropIdx(xw.idx);
  assert.deepStrictEqual(idx.tdStats(), { seen: 3, indexed: 3 });
  const r = mapPolyLegs([
    { symbol: 'astatc-nfl-pit-no-2026-10-25-td-noafan-gte1', side: 'SIDE_BUY' },
    { symbol: 'astatc-nfl-pit-no-2026-10-25-td-noafan-gte2', side: 'SIDE_SELL' },
    { symbol: 'astatc-nfl-pit-no-2026-10-25-td-dkmet-gte1', side: 'SIDE_SELL' },
  ], idx);
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual(r.legKeys, [`${EV}-NONFANT87-1:yes`, `${EV}-NONFANT87-2:no`, `${EV}-PITDKMETCALF14-1:no`]);
});

t('markets listed after the crosswalk arrives are indexed too; a refresh replaces old TD keys', async () => {
  const xw = await fetchLiveTdCrosswalk(fakeGet);
  const idx = createKalshiIndex(); idx.setPropIdx(xw.idx); idx.ingestMarkets(kalshiMarkets);
  assert.strictEqual(idx.tdStats().indexed, 3);
  idx.setPropIdx(PROPX.index([]));
  assert.strictEqual(idx.tdStats().indexed, 0);
});

t('wrong player name / team never maps (no guessing)', async () => {
  const bad = JSON.parse(JSON.stringify(polyEvent)); bad.event.markets[2].metadata.playerName = 'D.K. Metcalfe';
  const xw = await fetchLiveTdCrosswalk(async (u) => (/v1\/events\/slug/.test(u) ? bad : fakeGet(u)));
  const idx = createKalshiIndex(); idx.ingestMarkets(kalshiMarkets); idx.setPropIdx(xw.idx);
  assert.strictEqual(idx.tdStats().indexed, 2);
  const r = mapPolyLegs([{ symbol: 'astatc-nfl-pit-no-2026-10-25-td-noafan-gte1', side: 'SIDE_BUY' }, { symbol: 'astatc-nfl-pit-no-2026-10-25-td-dkmet-gte1', side: 'SIDE_BUY' }], idx);
  assert.strictEqual(r.reason, 'unmapped_leg');
  assert.deepStrictEqual(r.unmapped, ['astatc-nfl-pit-no-2026-10-25-td-dkmet-gte1']);
  assert.strictEqual(r.matched.length, 1);
});

t('skipped rows record matched/unmatched per leg', async () => {
  const xw = await fetchLiveTdCrosswalk(async (u) => (/v1\/events\/slug/.test(u) ? { event: { ...polyEvent.event, markets: polyEvent.event.markets.slice(0, 2) } } : fakeGet(u)));
  const idx = createKalshiIndex(); idx.ingestMarkets(kalshiMarkets); idx.setPropIdx(xw.idx);
  const rfq = { rfqId: 'r1', comboLegs: [{ symbol: 'astatc-nfl-pit-no-2026-10-25-td-noafan-gte1', side: 'SIDE_BUY' }, { symbol: 'astatc-nfl-pit-no-2026-10-25-td-dkmet-gte1', side: 'SIDE_BUY' }], qtyDecimal: '10' };
  const feed = { index: idx, pricesHealthy: () => true, venues: fairVenues({}) };
  const d = decidePoly(rfq, { feed, config: polySniperConfig({}), ledger: createVenueLedger(), nowMs: Date.parse('2026-10-24T16:00:00Z') });
  assert.strictEqual(d.reason, 'unmapped_leg');
  const rows = legRows(rfq, d);
  assert.deepStrictEqual(rows.map((r) => r.matched), [true, false]);
  assert.strictEqual(rows[0].ticker, `${EV}-NONFANT87-1`);
});

t('decision tape: a 1,000-row burst is fully written in batches, nothing dropped', async () => {
  const inserts = [];
  const supabase = { from: () => ({ insert: async (rows) => { inserts.push(rows.length); await new Promise((r) => setTimeout(r, 5)); return { error: null }; } }) };
  const lg = createDecisionLogger({ supabase, log: () => {}, batchMs: 10000, maxBatch: 200 });
  for (let i = 0; i < 1000; i += 1) lg.push({ action: 'skip', i });
  await new Promise((r) => setTimeout(r, 20));
  await lg.flush();
  assert.strictEqual(lg.stats.written, 1000);
  assert.strictEqual(lg.stats.dropped, 0);
  assert.ok(inserts.every((x) => x <= 200) && inserts.length >= 5);
});

t('crosswalk module is read-only: no trading verbs, no keys', async () => {
  const src = require('fs').readFileSync(require.resolve('./prop-xwalk'), 'utf8');
  assert.ok(!/createQuote|confirmQuote|deleteQuote|POLYMARKET_|API_KEY|SECRET|method:\s*['"](POST|PUT|DELETE)/i.test(src));
});

(async () => {
  for (const [name, fn] of tests) { await fn(); n += 1; console.log(`ok ${name}`); }
  console.log(`poly-sniper td-xwalk: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
