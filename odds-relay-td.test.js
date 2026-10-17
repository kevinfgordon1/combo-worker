'use strict';
// Odds relay TD lane: Novig TD markets on the signed socket, Polymarket US TD markets on the US socket,
// served as yes/no ask ladders at /td for the combo worker's multi-venue TD inverse.
const assert = require('assert');
const R = require('./odds-relay');
const nf = R.novigFeed;

// Novig /v3/limits -> stream bucket. Docs: capacity 512, refill 32/s (the old 4/s guess is gone).
assert.deepStrictEqual(nf.streamLimitsFrom({ stream: { capacity: 512, refillPerSec: 32 }, maxWatchedMarkets: 8192 }, {}), { capacity: 512, refill: 32, maxWatched: 8192, source: 'limits' });
assert.strictEqual(nf.streamLimitsFrom(null, {}).refill, 32);
assert.strictEqual(nf.streamLimitsFrom({ stream: { capacity: 512, refillPerSec: 32 } }, { NOVIG_STREAM_REFILL: '8' }).refill, 8);

// Polymarket US: event payload -> anytime (line 1) TD markets, away/home from the slug order.
const START = new Date(Date.now() + 86400e3).toISOString();
const ev = { event: { slug: 'nfl-bal-cle-2026-10-18', startTime: START, teams: [{ id: 1, displayAbbreviation: 'BAL', name: 'Baltimore Ravens' }, { id: 2, abbreviation: 'CLE', name: 'Cleveland Browns' }],
  markets: [
    { slug: 'td-henry-1', sportsMarketType: 'football_player_touchdowns', line: 1, active: true, metadata: { playerName: 'Derrick Henry', teamId: 1 }, feeCoefficient: 0.0695 },
    { slug: 'td-henry-2', sportsMarketType: 'football_player_touchdowns', line: 2, active: true, metadata: { playerName: 'Derrick Henry', teamId: 1 } },
    { slug: 'ml', sportsMarketType: 'moneyline', line: 0, active: true },
  ] } };
const ms = R.usTdMarketsFromEvent(ev);
assert.strictEqual(ms.length, 1);
assert.deepStrictEqual([ms[0].away, ms[0].home, ms[0].team, ms[0].player], ['Baltimore Ravens', 'Cleveland Browns', 'BAL', 'Derrick Henry']);
assert.strictEqual(R.usTdMarketsFromEvent({ event: { ...ev.event, startTime: new Date(Date.now() - 1000).toISOString() } }).length, 0); // started: never
// Subscriptions: <=100 slugs each, stable.
const many = Array.from({ length: 250 }, (_, i) => `s${String(i).padStart(3, '0')}`);
const ch = R.usTdChunks(many.slice().reverse());
assert.deepStrictEqual(ch.map((c) => c.length), [100, 100, 50]);
assert.deepStrictEqual(R.usTdChunks(many), ch);
// Book message -> ladders (No ask = 1 - bid), rows.
const catalog = new Map(ms.map((m) => [m.slug, m]));
const books = R.usTdBooksFromMessage({ marketData: { marketSlug: 'td-henry-1', offers: [{ px: { value: '0.58' }, qty: '900' }], bids: [{ px: { value: '0.56' }, qty: '1200' }, { px: { value: '0.55' }, qty: '5000' }] } }, catalog, 5);
assert.strictEqual(books.length, 1);
const td = { catalog, books: new Map([[books[0].slug, { ...books[0], at: 5 }]]), subscribed: new Set(['td-henry-1']) };
const now = Date.now();
const rows = R.usTdRows(td, { usSocketUp: true, usLastAliveAt: now }, now);
assert.strictEqual(rows.length, 1);
assert.deepStrictEqual(rows[0].yes, [{ odds: 0.58, size: 900 }]);
assert.deepStrictEqual(rows[0].no.map((x) => x.odds), [0.44, 0.45]);
assert.strictEqual(rows[0].confirmed_at, new Date(now).toISOString()); // socket alive + subscribed
const dead = R.usTdRows(td, { usSocketUp: false }, now);
assert.strictEqual(dead[0].confirmed_at, new Date(5).toISOString()); // only the book's own time

// Novig: TD catalog (strike 0.5, pregame) + socket books -> rows (Yes = Over ask = 1 - best Under bid).
(async () => {
  const NOW = Date.now();
  const events = { items: [{ eventId: 'e1', description: 'Baltimore Ravens @ Cleveland Browns', league: 'NFL', status: 'OPEN_PREGAME', startsTs: NOW + 86400e3 },
    { eventId: 'e2', description: 'Tennessee Titans @ Indianapolis Colts', league: 'NFL', status: 'OPEN_INGAME', startsTs: NOW - 3600e3 }] };
  const tdm = (id, ev, desc, strike = '0.5') => ({ marketId: id, eventId: ev, marketType: 'TOUCHDOWNS', strike, status: 'OPEN', description: desc, fee: { coefficient: '0.06', charged: 'WHEN_LIVE' }, outcomes: [{ outcomeId: `${id}-o`, name: 'Over 0.5' }, { outcomeId: `${id}-u`, name: 'Under 0.5' }] });
  const fetchFn = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (path.startsWith('/v3/public/catalog/events')) return json(events);
    if (path.startsWith('/v3/public/catalog/markets?') && /TOUCHDOWNS/.test(path)) return json({ items: [tdm('h', 'e1', 'Derrick Henry 0.5 TOUCHDOWNS'), tdm('h2', 'e1', 'Derrick Henry 1.5 TOUCHDOWNS', '1.5'), tdm('jt', 'e2', 'Jonathan Taylor 0.5 TOUCHDOWNS')] });
    if (path.startsWith('/v3/public/catalog/markets?')) return json({ items: [] });
    if (path.includes('/book')) return json({ seq: 1, orders: {} });
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const feed = nf.createNovigFeed({ env: { RELAY_TD: '1' }, fetchFn, leagues: ['NFL'], key: null, ws: false, log: () => {}, rps: 1000, concurrency: 2 });
  await feed.ready;
  await new Promise((r) => setTimeout(r, 200));
  await feed.refreshTdCatalog();
  feed.stop();
  assert.deepStrictEqual([...feed.tdMarkets.keys()], ['h']); // anytime only, pregame only
  feed.onWsBook('h', nf.bookFromSnapshot({ seq: 2, orders: { 'h-u': [{ orderId: 'a', price: 0.42, qty: 60000 }], 'h-o': [{ orderId: 'b', price: 0.55, qty: 90000 }] } }, NOW), NOW);
  const nr = feed.tdRows(NOW);
  assert.strictEqual(nr.length, 1);
  assert.strictEqual(nr[0].player, 'Derrick Henry');
  assert.deepStrictEqual(nr[0].yes, [{ odds: 0.58, size: 600 }]);
  assert.deepStrictEqual(nr[0].no, [{ odds: 0.45, size: 900 }]);
  assert.strictEqual(nr[0].away, 'Baltimore Ravens');
  assert.strictEqual(nr[0].confirmed_at, new Date(NOW).toISOString()); // no socket: book time only
  assert.strictEqual(feed.health().td.markets, 1);
  console.log('odds-relay-td.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
