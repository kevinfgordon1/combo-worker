'use strict';
// Multi-venue TD inverse (Combo Sniper): Kalshi + relay Polymarket US / Novig books, each gated alone.
const assert = require('assert');
const { createTdBook, samePlayer, venueGameKeys } = require('./td-book');
const { createPmLiveBook } = require('./pm-live');

assert(samePlayer('Kenneth Walker III', 'Kenneth Walker'));
assert(samePlayer("D'Andre Swift", 'DAndre Swift'));
assert(samePlayer('A.J. Brown', 'AJ Brown'));
assert(samePlayer('J. Taylor', 'Jonathan Taylor'));
assert(!samePlayer('Jonathan Taylor', 'Jamal Taylor'));
assert(!samePlayer('Bijan Robinson', 'Brian Robinson'));
assert(samePlayer('Kenny Gainwell', 'Kenneth Gainwell'));
assert(samePlayer('KC Concepcion Jr.', 'Kevin Concepcion'));
assert.deepStrictEqual(venueGameKeys('Baltimore Ravens', 'Cleveland Browns', '2026-10-18T17:00:00Z')[0], '2026-10-18|bal+cle');

let now = 1000000;
const tb = createTdBook({ now: () => now, venues: ['polymarket', 'novig'] });
const HENRY = 'KXNFLTD-26OCT18BALCLE-BALDHENRY22-1';
const TAYLOR = 'KXNFLTD-26OCT18TENIND-INDJTAYLOR28-1';
tb.setNames([{ ticker: HENRY, title: 'Derrick Henry: 1+ touchdowns' }, { ticker: TAYLOR, title: 'Jonathan Taylor: 1+ touchdowns' },
  { ticker: 'KXNFLTD-26OCT18TENIND-TENTPOLLARD20-1', title: 'Tony Pollard: 1+ touchdowns' }]);
// Kalshi: yes ask 0.56 (no bid 0.44), no ask 0.47 (yes bid 0.53). Deep.
tb.ingest([{ ticker: HENRY, orderbook_fp: { yes_dollars: [['0.53', '5000']], no_dollars: [['0.44', '5000']] } }]);
const row = (o) => ({ market: o.market, player: o.player, team: o.team || '', away: o.away || 'Baltimore Ravens', home: o.home || 'Cleveland Browns',
  start: '2026-10-18T17:00:00Z', live: false, yes: o.yes, no: o.no, fee_coefficient: o.coef, updated_at: new Date(now).toISOString(), confirmed_at: new Date(now).toISOString() });
// Polymarket: no ask 0.44 (+0.0695 fee) -> cheaper NO than Kalshi 0.47+0.07 fee.
tb.ingestVenue('polymarket', [row({ market: 'pm-henry', player: 'Derrick Henry', team: 'BAL', coef: 0.0695, yes: [{ odds: 0.58, size: 5000 }], no: [{ odds: 0.44, size: 5000 }] })], { polledAt: now });
// Novig: no ask 0.46, no fee pregame, but thin YES side -> dropped for depth.
tb.ingestVenue('novig', [row({ market: 'nv-henry', player: 'Derrick Henry', coef: 0.06, yes: [{ odds: 0.57, size: 10 }], no: [{ odds: 0.46, size: 5000 }] })], { polledAt: now });

let m = tb.legMulti({ id: HENRY, side: 'yes' });
const kNo = 0.47 + 0.07 * 0.47 * 0.53; const pNo = 0.44 + 0.0695 * 0.44 * 0.56;
assert.strictEqual(m.best, 'polymarket');
assert(Math.abs(m.p - (1 - pNo)) < 1e-9);
const by = Object.fromEntries(m.sources.map((s) => [s.venue, s]));
assert(by.kalshi.used && Math.abs(by.kalshi.cost - kNo) < 1e-9);
assert(by.polymarket.used && by.polymarket.key === 'pm-henry');
assert(!by.novig.used && by.novig.reason === 'depth');

// Novig deep on both sides now: 0.46 with no pregame fee beats Polymarket 0.44+fee (0.4571)? no: 0.46 > 0.4571.
tb.ingestVenue('novig', [row({ market: 'nv-henry', player: 'Derrick Henry', coef: 0.06, yes: [{ odds: 0.57, size: 5000 }], no: [{ odds: 0.455, size: 5000 }] })], { polledAt: now });
m = tb.legMulti({ id: HENRY, side: 'yes' });
assert.strictEqual(m.best, 'novig'); assert(Math.abs(m.p - (1 - 0.455)) < 1e-9);
// Novig once live charges its coefficient.
tb.ingestVenue('novig', [{ ...row({ market: 'nv-henry', player: 'Derrick Henry', coef: 0.06, yes: [{ odds: 0.57, size: 5000 }], no: [{ odds: 0.455, size: 5000 }] }), live: true }], { polledAt: now });
m = tb.legMulti({ id: HENRY, side: 'yes' });
assert.strictEqual(m.best, 'polymarket');

// Overround cap per venue.
tb.ingestVenue('polymarket', [row({ market: 'pm-henry', player: 'Derrick Henry', team: 'BAL', yes: [{ odds: 0.70, size: 5000 }], no: [{ odds: 0.44, size: 5000 }] })], { polledAt: now });
m = tb.legMulti({ id: HENRY, side: 'yes' });
assert.strictEqual(m.sources.find((s) => s.venue === 'polymarket').reason, 'overround');

// Stale relay venues (relay down) -> Kalshi alone, same as the old path.
now += 16000;
tb.ingest([{ ticker: HENRY, orderbook_fp: { yes_dollars: [['0.53', '5000']], no_dollars: [['0.44', '5000']] } }]);
m = tb.legMulti({ id: HENRY, side: 'yes' });
assert.strictEqual(m.best, 'kalshi'); assert(Math.abs(m.p - (1 - kNo)) < 1e-9);
assert(m.sources.filter((s) => s.venue !== 'kalshi').every((s) => s.reason === 'stale'));
const old = tb.legStats({ id: HENRY, side: 'yes' });
assert(Math.abs(old.inverse - m.p) < 1e-12); // legStats (quoting variants) unchanged, Kalshi only

// Team mismatch and wrong game don't match; unmatched counted.
tb.takeMatchStats();
tb.ingestVenue('polymarket', [row({ market: 'x', player: 'Derrick Henry', team: 'CLE' }), row({ market: 'y', player: 'Derrick Henry', away: 'Tennessee Titans', home: 'Indianapolis Colts' })], { polledAt: now });
assert.deepStrictEqual(tb.takeMatchStats().polymarket, { matched: 0, unmatched: 2, ambiguous: 0 });
// Suffix / initials across venues.
tb.ingestVenue('novig', [row({ market: 'nv-jt', player: 'J. Taylor', away: 'Tennessee Titans', home: 'Indianapolis Colts', yes: [{ odds: 0.5, size: 5000 }], no: [{ odds: 0.52, size: 5000 }] })], { polledAt: now });
assert.strictEqual(tb.takeMatchStats().novig.matched, 1);

// pm-live comboFair logs every TD venue (like moneylines) and uses the best.
now += 1;
const tb2 = createTdBook({ now: () => now, venues: ['polymarket'] });
tb2.setNames([{ ticker: HENRY, title: 'Derrick Henry: 1+ touchdowns' }]);
tb2.ingest([{ ticker: HENRY, orderbook_fp: { yes_dollars: [['0.53', '5000']], no_dollars: [['0.44', '5000']] } }]);
tb2.ingestVenue('polymarket', [row({ market: 'pm-henry', player: 'Derrick Henry', team: 'BAL', yes: [{ odds: 0.58, size: 5000 }], no: [{ odds: 0.44, size: 5000 }] })], { polledAt: now });
const pm = createPmLiveBook({ now: () => now });
pm.setTdBook(tb2);
const f = pm.comboFair([{ kind: 'td', id: HENRY, side: 'yes' }]);
assert.strictEqual(f.reason, 'ok');
assert.strictEqual(f.legs[0].best, 'polymarket');
assert.deepStrictEqual(f.legs[0].sources.map((s) => [s.venue, s.used]), [['kalshi', true], ['polymarket', true]]);
assert(Math.abs(f.p - (1 - pNo)) < 1e-9);
// Kalshi-only TD book (no venues configured) behaves exactly like before.
const tb3 = createTdBook({ now: () => now });
tb3.ingest([{ ticker: HENRY, orderbook_fp: { yes_dollars: [['0.53', '5000']], no_dollars: [['0.44', '5000']] } }]);
pm.setTdBook(tb3);
const g = pm.comboFair([{ kind: 'td', id: HENRY, side: 'yes' }]);
assert.strictEqual(g.legs[0].best, 'kalshi'); assert(Math.abs(g.p - (1 - kNo)) < 1e-9);
console.log('noboost/td-multivenue.test.js ok');
