'use strict';
// Polymarket US spreads/totals for the relay: slug semantics, main pick, ladders, quote shape.
const assert = require('assert');
const P = require('./poly-us-lines');
const side = (long, desc, team) => ({ long, description: desc, ...(team ? { team } : {}) });
const PIT = { name: 'Pittsburgh Steelers', abbreviation: 'pit', ordering: 'away' };
const NO = { name: 'New Orleans Saints', abbreviation: 'no', ordering: 'home' };
const q = (v) => ({ value: String(v) });
const ev = {
  slug: 'nfl-pit-no-2026-10-25', startTime: '2026-10-25T13:30:00Z', teams: [{ name: PIT.name, abbreviation: 'pit' }, { name: NO.name, abbreviation: 'no' }],
  markets: [
    { slug: 'asc-nfl-pit-no-2026-10-25-neg-3pt5', sportsMarketType: 'football_team_full_game_spread', line: -3.5, marketSides: [side(true, '-3.50', PIT), side(false, '+3.50', NO)], bestBidQuote: q(0.465), bestAskQuote: q(0.47) },
    { slug: 'asc-nfl-pit-no-2026-10-25-pos-1pt5', sportsMarketType: 'football_team_full_game_spread', line: 1.5, marketSides: [side(true, '+1.50', PIT), side(false, '-1.50', NO)], bestBidQuote: q(0.635), bestAskQuote: q(0.645) },
    { slug: 'asc-nfl-pit-no-2026-10-25-1h-pos-3pt5', sportsMarketType: 'football_team_first_half_spread', line: 3.5, marketSides: [side(true, '+3.50', PIT), side(false, '-3.50', NO)], bestBidQuote: q(0.5), bestAskQuote: q(0.5) },
    { slug: 'tsc-nfl-pit-no-2026-10-25-total-44pt5', sportsMarketType: 'football_team_full_game_total', line: 44.5, marketSides: [side(true, 'Over'), side(false, 'Under')], bestBidQuote: q(0.5), bestAskQuote: q(0.51) },
    { slug: 'tsc-nfl-pit-no-2026-10-25-total-41pt5', sportsMarketType: 'football_team_full_game_total', line: 41.5, marketSides: [side(true, 'Over'), side(false, 'Under')], bestBidQuote: q(0.595), bestAskQuote: q(0.6) },
    { slug: 'x-team-total', sportsMarketType: 'football_team_points_full_game_total', line: 20.5, marketSides: [side(true, 'Over'), side(false, 'Under')], bestBidQuote: q(0.5), bestAskQuote: q(0.5) },
    { slug: 'tsc-nfl-pit-no-2026-10-25-total-44', sportsMarketType: 'football_team_full_game_total', line: 44, marketSides: [side(true, 'Over'), side(false, 'Under')], bestBidQuote: q(0.5), bestAskQuote: q(0.5) },
  ],
};
const ms = P.lineMarketsFromEvent(ev, 'NFL', 3);
assert.deepStrictEqual(ms.map((m) => m.slug).sort(), ['asc-nfl-pit-no-2026-10-25-neg-3pt5', 'asc-nfl-pit-no-2026-10-25-pos-1pt5', 'tsc-nfl-pit-no-2026-10-25-total-41pt5', 'tsc-nfl-pit-no-2026-10-25-total-44pt5'], 'full game only, x.5 only, no team totals / halves');
const sp = ms.find((m) => m.slug.endsWith('neg-3pt5'));
assert.strictEqual(sp.isAlt, false, 'most balanced spread is main');
assert.deepStrictEqual([sp.yes.side, sp.yes.line, sp.no.side, sp.no.line], [PIT.name, -3.5, NO.name, 3.5], 'neg-3pt5: long = PIT −3.5, short = NO +3.5');
const pos = ms.find((m) => m.slug.endsWith('pos-1pt5'));
assert.deepStrictEqual([pos.yes.side, pos.yes.line, pos.no.side, pos.no.line, pos.isAlt], [PIT.name, 1.5, NO.name, -1.5, true]);
const to = ms.find((m) => m.slug.endsWith('total-44pt5'));
assert.deepStrictEqual([to.yes.side, to.no.side, to.line, to.isAlt, to.away, to.home], ['Over', 'Under', 44.5, false, PIT.name, NO.name]);
assert.strictEqual(P.lineMarketsFromEvent(ev, 'NFL', 1).length, 2, 'one strike per type by default');
// college: no ordering on teams -> slug order (first = away), sides without team -> long = first slug team
const cfb = { slug: 'cfb-duke-vir-2026-10-24', startTime: '2026-10-24T16:00:00Z', teams: [{ name: 'Virginia', abbreviation: 'vir' }, { name: 'Duke', abbreviation: 'duke' }],
  markets: [{ slug: 'asc-cfb-duke-vir-2026-10-24-neg-10pt5', sportsMarketType: 'football_team_full_game_spread', line: -10.5, marketSides: [side(true, '-10.50'), side(false, '+10.50')], bestBidQuote: q(0.5), bestAskQuote: q(0.52) }] };
const c = P.lineMarketsFromEvent(cfb, 'NCAAF', 1)[0];
assert.deepStrictEqual([c.away, c.home, c.yes.side, c.yes.abbr, c.yes.line, c.no.side, c.no.line], ['Duke', 'Virginia', 'Duke', 'duke', -10.5, 'Virginia', 10.5]);
// ladders: offers = Yes asks; bids -> No asks (1 − bid), cheapest first
const ld = P.laddersFromBook({ offers: [{ px: q(0.475), qty: '100' }, { px: q(0.47), qty: '50' }], bids: [{ px: q(0.465), qty: '200' }, { px: q(0.46), qty: '10' }] });
assert.deepStrictEqual(ld.yes, [{ odds: 0.47, size: 50 }, { odds: 0.475, size: 100 }]);
assert.deepStrictEqual(ld.no, [{ odds: 0.535, size: 200 }, { odds: 0.54, size: 10 }]);
const qs = P.quotesFor(sp, ld, Date.parse('2026-10-23T05:00:00Z'));
assert.strictEqual(qs.length, 2);
assert.deepStrictEqual([qs[0].bet_type, qs[0].side, qs[0].line, qs[0].odds, qs[0].feed, qs[0].token_id], ['spread', PIT.name, -3.5, 0.47, 'polymarket-us-lines', 'us:asc-nfl-pit-no-2026-10-25-neg-3pt5:yes']);
assert.deepStrictEqual([qs[1].side, qs[1].line, qs[1].odds], [NO.name, 3.5, 0.535]);
const tq = P.quotesFor(to, ld, 0);
assert.deepStrictEqual([tq[0].side_type, tq[1].side_type, tq[1].line], ['Over', 'Under', 44.5]);
// window: live / past / beyond horizon excluded
const now = Date.parse('2026-10-23T05:00:00Z');
assert.strictEqual(P.inWindow({ startTime: '2026-10-25T13:30:00Z' }, now, 3), true);
assert.strictEqual(P.inWindow({ startTime: '2026-10-30T13:30:00Z' }, now, 3), false);
assert.strictEqual(P.inWindow({ startTime: '2026-10-25T13:30:00Z', live: true }, now, 3), false);
// relay rows: books from the socket, confirmed_at = now while alive + subscribed
const { usLinesRows } = require('./odds-relay');
const lines = { catalog: new Map([[sp.slug, sp]]), books: new Map([[sp.slug, { ladders: ld, ts: now - 60000, at: now - 60000 }]]), subscribed: new Set([sp.slug]) };
const alive = { usSocketUp: true, usLastAliveAt: now - 1000 };
const rows = usLinesRows(lines, alive, 'NFL', now);
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[0].confirmed_at, new Date(now).toISOString(), 'quiet book on a live socket is current');
assert.strictEqual(usLinesRows(lines, { usSocketUp: false }, 'NFL', now)[0].confirmed_at, new Date(now - 60000).toISOString(), 'socket down => last frame time');
assert.strictEqual(usLinesRows(lines, alive, 'NCAAF', now).length, 0);
console.log('poly-us-lines.test ok');
