// Kevin Nov 2 2026 (5:15 PM ET): price every leg off the BEST opposing $500 price across
// Kalshi, Polymarket US, Novig and ProphetX (each fee-included), port aibetbuilder #550
// (wrong-game match + rogue-ladder guard). Sandbox quoter only.
'use strict';
const assert = require('assert');
const bd = require('./vendor/book-depth');
const { createPricer, guardLadders } = require('./pricer');
const { pickOppQuote, levelsFromQuote, boardLive, createRelayDepth } = require('./relay-depth');
const { ourTrueFromOpponents } = require('../unhedged-quote');

const T = Date.parse('2026-11-03T00:30:00Z');
const iso = (ms) => new Date(ms).toISOString();

(async () => {
  // ---- #550 wrong-game: each team must match its own title words --------------------------
  assert.strictEqual(bd.eventMatchesTeams('Texas A&M Commerce @ Oklahoma', 'Texas A&M-CC Islanders', 'Texas State Bobcats'), false);
  assert.strictEqual(bd.eventMatchesTeams('Texas A&M-Corpus Christi @ Texas State', 'Texas A&M-CC Islanders', 'Texas State Bobcats'), true);
  assert.strictEqual(bd.eventMatchesTeams('Texas @ Texas Tech', 'Texas Longhorns', 'Texas Tech Red Raiders'), true);
  // Relay boards use the same rule: wrong game listed first, same tip time → never picked.
  const q = (away, home, side, odds, extra = {}) => ({ bet_type: 'moneyline', away, home, side, odds, size: 5000, start: iso(T), updated_at: iso(T - 60_000), ...extra });
  const board = [
    q('Texas A&M-Commerce Lions', 'Oklahoma Sooners', 'Texas A&M-Commerce Lions', 0.01),
    q('Texas A&M-Commerce Lions', 'Oklahoma Sooners', 'Oklahoma Sooners', 0.99),
    q('Texas A&M-CC Islanders', 'Texas State Bobcats', 'Texas A&M-CC Islanders', 0.19),
    q('Texas A&M-CC Islanders', 'Texas State Bobcats', 'Texas State Bobcats', 0.83),
  ];
  const leg = { market: 'ML', bestOppName: 'Texas A&M-CC Islanders', game: 'Texas A&M-CC Islanders @ Texas State Bobcats', sport: 'basketball_ncaab', commence_time: iso(T) };
  const pk = pickOppQuote('prophetx', board, leg);
  assert.strictEqual(pk.reason, 'ok');
  assert.strictEqual(pk.q.home, 'Texas State Bobcats', 'right game');
  assert.strictEqual(pk.q.side, 'Texas A&M-CC Islanders', 'opponent side');
  // Never the other team of the matched event as "opponent".
  const self = pickOppQuote('prophetx', board.slice(2, 3), leg);
  assert.strictEqual(self.q && self.q.side, 'Texas A&M-CC Islanders');
  assert.strictEqual(pickOppQuote('prophetx', board.slice(3), leg).q, null, 'only our own team listed -> no opponent');

  // ---- #550 rogue-ladder guard ---------------------------------------------------------------
  // Novig wrong-game +9900 vs the venue feed +456 → dropped (3x odds / 2c rule); +426 kept.
  let g = guardLadders({ novig: [{ american: 9900, size: 10000 }] }, { novig: 456 });
  assert.deepStrictEqual(g.kept.novig, []);
  assert.match(g.dropped.novig, /^rogue_vs_feed/);
  g = guardLadders({ novig: [{ american: 426, size: 10000 }] }, { novig: 456 });
  assert.strictEqual(g.kept.novig.length, 1);
  // No feed price: reference = median of the other venues' tops.
  g = guardLadders({ kalshi: [{ american: 400, size: 9e4 }], polymarket: [{ american: 410, size: 9e4 }], novig: [{ american: 9900, size: 9e4 }] });
  assert.deepStrictEqual(g.kept.novig, []);
  assert.strictEqual(g.kept.kalshi.length, 1);
  assert.strictEqual(g.kept.polymarket.length, 1);

  // ---- relay ladders: fees + freshness -------------------------------------------------------
  const px = levelsFromQuote('prophetx', { odds: 0.1136, size: 100, depth: [{ odds: 0.1136, size: 100 }] });
  assert.strictEqual(px[0].american, 764, 'ProphetX +780 less 2% of winnings = +764');
  const pm = levelsFromQuote('polymarket', { odds: 0.12, depth: [{ odds: 0.12, size: 1000 }] });
  assert.strictEqual(pm[0].american, bd.applyVenueFee('polymarket', 733), 'Polymarket US fee 0.0695·p·(1−p)');
  assert.ok(Math.abs(pm[0].size - 120) < 1e-9, 'Polymarket US size = contracts → $ stake');
  assert.strictEqual(boardLive([{ updated_at: iso(T - 5000) }], T, 15000), true);
  assert.strictEqual(boardLive([{ updated_at: iso(T - 60000) }], T, 15000), false);

  // Relay venue freshness through createRelayDepth (fake fetch, fake clock).
  let clock = T - 3 * 3600_000;
  const nba = (side, odds, upd, conf) => ({ bet_type: 'moneyline', away: 'Brooklyn Nets', home: 'New York Knicks', side, odds, size: 1e5, depth: [{ odds, size: 1e5 }], start: iso(T), updated_at: iso(upd), confirmed_at: conf ? iso(conf) : undefined, feed: 'polymarket-us' });
  const boards = {
    polymarket: [nba('Brooklyn Nets', 0.12, clock - 3600_000, clock - 1000)],
    prophetx: [nba('Brooklyn Nets', 0.1136, clock - 60_000)], // socket quiet 60s → stale
  };
  const fakeFetch = async (url) => { const v = /venue=(\w+)/.exec(url)[1]; return { ok: true, status: 200, json: async () => ({ ok: true, quotes: boards[v] || [] }) }; };
  const rd = createRelayDepth({ base: 'http://kaygo-odds-relay.internal:8787', fetch: fakeFetch, now: () => clock });
  const knLeg = { market: 'ML', bestOppName: 'Brooklyn Nets', game: 'Brooklyn Nets @ New York Knicks', sport: 'basketball_nba', commence_time: iso(T) };
  const rPm = await rd.venueDepth('polymarket', knLeg);
  assert.strictEqual(rPm.reason, 'ok', 'Polymarket US confirmed 1s ago → fresh');
  const rPx = await rd.venueDepth('prophetx', knLeg);
  assert.strictEqual(rPx.reason, 'stale', 'ProphetX quote 60s old with a quiet board → stale (15s rule)');
  rd.stop();

  // ---- multi-venue best price (inverse bet across all four venues) ---------------------------
  const ladder = (a) => [{ american: a, size: 1e6 }];
  const resolve = async (legs) => legs.map((l) => ({ kalshi: { levels: ladder(189), reason: 'ok' }, novig: { levels: ladder(203), reason: 'ok' } })[l.bestOppBook]);
  const relay = {
    venueDepth: async (v) => (v === 'polymarket' ? { venue: v, levels: ladder(210), reason: 'ok' } : { venue: v, levels: ladder(199), reason: 'ok' }),
    feedTop: async () => null,
  };
  const pr = createPricer({ resolve, relay, now: () => T, logger: { warn() {}, log() {} } });
  const info = { strikeId: 's1', kind: 'ML', team: 'Detroit Pistons', opp: 'Charlotte Hornets', oppLabel: 'Charlotte Hornets', sport: 'basketball_nba', game: 'Detroit Pistons @ Charlotte Hornets', startMs: T };
  const r = await pr.legPrice(info);
  assert.deepStrictEqual(r.venues, { kalshi: 189, novig: 203, polymarket: 210, prophetx: 199 });
  assert.strictEqual(r.best.venue, 'polymarket', 'best opposing price wins, whichever venue');
  assert.ok(Math.abs(r.p - ourTrueFromOpponents([{ american: 210 }])) < 1e-12);
  // A stale / missing venue is simply not a candidate.
  const pr2 = createPricer({ resolve, relay: { venueDepth: async (v) => ({ venue: v, levels: [], reason: 'stale' }) }, now: () => T, logger: { warn() {} } });
  const r2 = await pr2.legPrice({ ...info, strikeId: 's2' });
  assert.strictEqual(r2.best.venue, 'novig');
  assert.strictEqual(r2.reasons.polymarket, 'stale');
  // A rogue venue (wrong-game +9900) cannot be the best price.
  const pr3 = createPricer({ resolve, relay: { venueDepth: async (v) => ({ venue: v, levels: ladder(v === 'prophetx' ? 9900 : 200), reason: 'ok' }), feedTop: async () => null }, now: () => T, logger: { warn() {} } });
  const r3 = await pr3.legPrice({ ...info, strikeId: 's3' });
  assert.notStrictEqual(r3.best.venue, 'prophetx');
  assert.match(r3.reasons.prophetx, /^rogue/);
  // $500 profit walk still decides completeness: a $50-deep ladder can't be the best.
  const pr4 = createPricer({ resolve, relay: { venueDepth: async (v) => ({ venue: v, levels: [{ american: 250, size: 20 }], reason: 'ok' }) }, now: () => T, logger: { warn() {} } });
  const r4 = await pr4.legPrice({ ...info, strikeId: 's4' });
  assert.strictEqual(r4.venues.polymarket, null);
  assert.strictEqual(r4.best.venue, 'novig');

  // ---- vendored book-depth: Novig wrong-game end to end (aibetbuilder #550 test) -------------
  await (async function run() {
    const tip = Date.parse('2026-11-03T01:00:00Z');
    const MONEY = (id, h, a) => ({ marketId: id, marketType: 'MONEY', status: 'OPEN', outcomes: [{ outcomeId: id + 'h', name: h }, { outcomeId: id + 'a', name: a }] });
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      let json = {};
      // Wrong game listed FIRST, same start time.
      if (u.includes('/catalog/events')) json = { items: [
        { eventId: 'ETAM', description: 'Texas A&M Commerce @ Oklahoma', status: 'OPEN_PREGAME', startsTs: tip },
        { eventId: 'AMCC', description: 'Texas A&M-Corpus Christi @ Texas State', status: 'OPEN_PREGAME', startsTs: tip },
      ] };
      else if (u.includes('markets?event=ETAM')) json = { items: [MONEY('M1', 'OKLA', 'ETAM')] };
      else if (u.includes('markets?event=AMCC')) json = { items: [MONEY('M2', 'TXST', 'AMCC')] };
      else if (u.includes('/markets/M1/book')) json = { orders: { M1h: [{ price: '0.99', qty: 1383941 }] } };
      else if (u.includes('/markets/M2/book')) json = { orders: { M2h: [{ price: '0.81', qty: 49635 }, { price: '0.01', qty: 246600 }], M2a: [{ price: '0.14', qty: 60000 }] } };
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
    };
    try {
      if (bd._resetCatalogCache) bd._resetCatalogCache();
      const [r] = await bd.resolveLegsDepth([{ bestOppBook: 'novig', sport: 'basketball_ncaab', market: 'ML', game: 'Texas A&M-CC Islanders @ Texas State Bobcats', bestOppName: 'Texas A&M-CC Islanders', name: 'Texas State Bobcats', commence_time: '2026-11-03T01:00:00Z' }]);
      assert.equal(r.reason, 'ok', JSON.stringify(r));
      assert.equal(r.levels[0].american, 426, JSON.stringify(r.levels));
      assert.ok(!r.levels.some((l) => l.american === 9900), 'never the Commerce/Oklahoma book');
    } finally { global.fetch = realFetch; }
    console.log('book-depth novig wrong-game tests passed');
  })();
  console.log('px/pricer-venues.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
