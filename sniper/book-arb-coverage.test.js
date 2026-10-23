'use strict';
// Spreads / totals (exact line only) and NCAAF (FBS) ML / spread / total for the arb-out check.
const assert = require('assert');
const { checkFill, parseLeg, legType, coverage, formatCoverage, ncaafCodeOfOddsName } = require('./book-arb');
const bk = (key, markets) => ({ key, markets });
const nfl = [{ away_team: 'New York Giants', home_team: 'Houston Texans', commence_time: '2026-10-25T17:00:00Z', bookmakers: [
  bk('draftkings', [{ key: 'spreads', outcomes: [{ name: 'New York Giants', point: 10.5, price: -110 }, { name: 'Houston Texans', point: -10.5, price: -110 }] }]),
  bk('fanduel', [{ key: 'spreads', outcomes: [{ name: 'New York Giants', point: 10, price: -105 }, { name: 'Houston Texans', point: -10, price: -115 }] }]),
  bk('pinnacle', [{ key: 'spreads', outcomes: [{ name: 'New York Giants', point: 10.5, price: 150 }] }]),
] }, { away_team: 'Dallas Cowboys', home_team: 'Philadelphia Eagles', commence_time: '2026-10-27T00:20:00Z', bookmakers: [
  bk('betmgm', [{ key: 'totals', outcomes: [{ name: 'Over', point: 44.5, price: -108 }, { name: 'Under', point: 44.5, price: -112 }] }]),
  bk('draftkings', [{ key: 'totals', outcomes: [{ name: 'Over', point: 45.5, price: 100 }] }]),
] }];
// Kalshi strike rule: HOU11 = HOU −10.5 (No = NYG +10.5); DALPHI-45 = 44.5.
const sp = parseLeg('KXNFLSPREAD-26OCT25NYGHOU-HOU11:no');
assert.strictEqual(sp.kind, 'line'); assert.strictEqual(sp.line, 10.5); assert.strictEqual(legType(sp), 'nfl_spread');
const r1 = checkFill({ legs: ['KXNFLSPREAD-26OCT25NYGHOU-HOU11:no'], contracts: 100, cost: 40 }, { odds: nfl });
assert.deepStrictEqual(Object.keys(r1.legs[0].prices), ['draftkings'], 'only the exact line counts; non-US books ignored');
assert.strictEqual(r1.legs[0].name, 'NYG +10.5');
const r2 = checkFill({ legs: ['KXNFLTOTAL-26OCT26DALPHI-45:yes'], contracts: 100, cost: 40 }, { odds: nfl });
assert.deepStrictEqual(r2.legs[0].prices, { betmgm: -108 }); assert.strictEqual(r2.legs[0].name, 'Over 44.5');
const r2n = checkFill({ legs: ['KXNFLTOTAL-26OCT26DALPHI-45:no'], contracts: 100, cost: 40 }, { odds: nfl });
assert.deepStrictEqual(r2n.legs[0].prices, { betmgm: -112 });
// Arb math on a 2-leg spread+total parlay: DK has no total at 44.5 → BetMGM lacks the spread → no common book.
const r3 = checkFill({ legs: ['KXNFLSPREAD-26OCT25NYGHOU-HOU11:no', 'KXNFLTOTAL-26OCT26DALPHI-45:yes'], contracts: 100, cost: 60 }, { odds: nfl });
assert.strictEqual(r3.reason, 'no_book_has_every_leg');

// NCAAF: odds names with mascots; Kalshi dates the Saturday game a day early (Fri) → next-day fallback.
assert.strictEqual(ncaafCodeOfOddsName('Texas A&M Aggies'), 'TXAM');
assert.strictEqual(ncaafCodeOfOddsName('Miami Hurricanes'), 'MIA');
assert.strictEqual(ncaafCodeOfOddsName('Miami (OH) RedHawks'), 'MOH');
const cfb = [{ away_team: 'Texas A&M Aggies', home_team: 'Alabama Crimson Tide', commence_time: '2026-10-24T19:30:00Z', bookmakers: [
  bk('draftkings', [{ key: 'h2h', outcomes: [{ name: 'Alabama Crimson Tide', price: -200 }, { name: 'Texas A&M Aggies', price: 170 }] },
    { key: 'spreads', outcomes: [{ name: 'Alabama Crimson Tide', point: -5.5, price: -110 }, { name: 'Texas A&M Aggies', point: 5.5, price: -110 }] },
    { key: 'totals', outcomes: [{ name: 'Over', point: 49.5, price: -110 }, { name: 'Under', point: 49.5, price: -110 }] }]),
  bk('fanduel', [{ key: 'h2h', outcomes: [{ name: 'Alabama Crimson Tide', price: -190 }, { name: 'Texas A&M Aggies', price: 160 }] }]),
] }];
const ml = checkFill({ legs: ['KXNCAAFGAME-26OCT23TXAMALA-ALA:yes'], contracts: 100, cost: 30 }, { ncaafOdds: cfb });
assert.deepStrictEqual(ml.legs[0].prices, { draftkings: -200, fanduel: -190 }); assert.strictEqual(ml.legs[0].type, 'ncaaf_ml');
const mlNo = checkFill({ legs: ['KXNCAAFGAME-26OCT24TXAMALA-ALA:no'], contracts: 100, cost: 30 }, { ncaafOdds: cfb });
assert.deepStrictEqual(mlNo.legs[0].prices, { draftkings: 170, fanduel: 160 });
// Two days off → no match.
assert.strictEqual(checkFill({ legs: ['KXNCAAFGAME-26OCT22TXAMALA-ALA:yes'], contracts: 100, cost: 30 }, { ncaafOdds: cfb }).reason, 'game_not_found');
// Ambiguous (same pair on ticker day AND next day) → refuse.
const dup = [...cfb, { ...cfb[0], commence_time: '2026-10-23T19:30:00Z' }];
assert.strictEqual(checkFill({ legs: ['KXNCAAFGAME-26OCT23TXAMALA-ALA:yes'], contracts: 100, cost: 30 }, { ncaafOdds: dup }).reason, 'ncaaf_game_ambiguous');
const csp = checkFill({ legs: ['KXNCAAFSPREAD-26OCT23TXAMALA-ALA6:yes'], contracts: 100, cost: 30 }, { ncaafOdds: cfb });
assert.deepStrictEqual(csp.legs[0].prices, { draftkings: -110 }); assert.strictEqual(csp.legs[0].type, 'ncaaf_spread');
assert.strictEqual(checkFill({ legs: ['KXNCAAFSPREAD-26OCT23TXAMALA-ALA5:yes'], contracts: 100, cost: 30 }, { ncaafOdds: cfb }).reason, 'no_book_on_exact_line');
const ctot = checkFill({ legs: ['KXNCAAFTOTAL-26OCT23TXAMALA-50:no'], contracts: 100, cost: 30 }, { ncaafOdds: cfb });
assert.deepStrictEqual(ctot.legs[0].prices, { draftkings: -110 }); assert.strictEqual(ctot.legs[0].type, 'ncaaf_total');
// Cross-league parlay: NCAAF ML (DK −200) × NFL total (BetMGM only) → no shared book; NCAAF ML alone → arb.
// Sold YES at 0.30 on a −200 leg (book implied 0.667) → no arb; at cost 20 (YES 0.80 > 0.667) → arb.
const arb = checkFill({ legs: ['KXNCAAFGAME-26OCT23TXAMALA-ALA:yes'], contracts: 100, cost: 20 }, { ncaafOdds: cfb });
assert.strictEqual(arb.reason, 'arb'); assert.strictEqual(arb.best.label, 'FanDuel');
// Coverage line counts by leg type.
const cov = coverage([r1, r2, ml, arb, checkFill({ legs: ['KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:no'], contracts: 1, cost: 0.5 }, {})]);
assert.strictEqual(cov.fills, 5); assert.strictEqual(cov.priceable, 4); assert.strictEqual(cov.tdNoFills, 1);
const line = formatCoverage(cov);
assert.ok(/4 of 5 open fills priceable/.test(line) && /NFL spread 1\/1 legs/.test(line) && /NCAAF ML 2\/2 legs/.test(line) && /TD No \(unhedgeable\) 0\/1/.test(line), line);
console.log('sniper/book-arb-coverage.test.js ok');
