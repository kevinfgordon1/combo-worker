'use strict';
// Odds relay Novig feed: follow markets cursor, MONEY on its own (live NCAAF moneyline went missing).
// Novig markets are paged (5000 rows, `next` cursor, newest first). A live
// game's moneyline sits on a later page; the feed must follow the cursor and
// ask for MONEY on its own so live NCAAF games keep their Novig prices.
const assert = require('assert');

const NOW = Date.now();
const mkEvent = (id, desc, status, startsTs) => ({ eventId: id, description: desc, sport: 'FOOTBALL', league: 'NCAAF', status, startsTs });
const events = { items: [
  mkEvent('e-live', 'Pittsburgh @ Virginia Tech', 'OPEN_INGAME', NOW - 3 * 3600e3),
  mkEvent('e-pre', 'Georgia @ Alabama', 'OPEN_PREGAME', NOW + 3600e3),
] };
const money = (id, ev, a, h) => ({ marketId: id, eventId: ev, marketType: 'MONEY', strike: '0', status: 'OPEN', fee: { coefficient: '0.03', charged: 'WHEN_LIVE' }, outcomes: [{ outcomeId: `${id}-h`, name: h }, { outcomeId: `${id}-a`, name: a }] });
const total = (id, ev, strike) => ({ marketId: id, eventId: ev, marketType: 'TOTAL', strike: String(strike), status: 'OPEN', description: 'PITT @ VT t', outcomes: [{ outcomeId: `${id}-o`, name: `Over ${strike}` }, { outcomeId: `${id}-u`, name: `Under ${strike}` }] });
const MONEY_ROWS = [money('m-pre', 'e-pre', 'UGA', 'ALA'), money('m-live', 'e-live', 'PITT', 'VT')];
// Page 1 of SPREAD,TOTAL holds the pregame rows, page 2 the live game's.
const PAGE1 = { items: [total('t-pre', 'e-pre', 55.5)], next: 'cur1' };
const PAGE2 = { items: [total('t-live', 'e-live', 61.5)] };

function build(nf) {
  const calls = [];
  const fetchFn = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push(path);
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (path.startsWith('/v3/public/catalog/events')) return json(events);
    if (path.startsWith('/v3/public/catalog/markets?')) {
      const q = new URL(`http://x${path}`).searchParams;
      const types = q.get('marketType');
      if (types === 'MONEY') return json({ items: MONEY_ROWS });
      if (q.get('after') === 'cur1') return json(PAGE2);
      return json(PAGE1);
    }
    if (path.includes('/book')) {
      return json({ seq: 5, orders: {} });
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  return { calls, fetchFn };
}

module.exports = async function run(nf) {
  const { calls, fetchFn } = build(nf);
  const feed = nf.createNovigFeed({
    env: {}, fetchFn, leagues: ['NCAAF'], key: null, ws: false, log: () => {},
    rps: 1000, concurrency: 2, hotMs: 60000, nearMs: 60000, warmMs: 60000, coldMs: 60000,
  });
  await feed.ready;
  await new Promise((r) => setTimeout(r, 300));
  feed.stop();
  const marketCalls = calls.filter((c) => c.startsWith('/v3/public/catalog/markets?'));
  assert.ok(marketCalls.some((c) => /marketType=MONEY&/.test(c)), 'MONEY is requested on its own');
  assert.ok(marketCalls.some((c) => /after=cur1/.test(c)), 'markets cursor is followed');
  assert.ok(calls.some((c) => c.includes('/markets/m-live/book')), 'live game moneyline market is polled');
  assert.ok(calls.some((c) => c.includes('/markets/t-live/book')), 'live game total on page 2 is polled');
};
module.exports(require('./odds-relay').novigFeed).then(() => console.log('novig-paging.test.js ok')).catch((e) => { console.error(e); process.exit(1); });
