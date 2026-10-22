'use strict';
const assert = require('assert');
const { checkFill, formatArbAlert, parseLeg, nameMatches } = require('./book-arb');
const { createBookArbWatch } = require('./book-arb-watch');
assert.deepStrictEqual(parseLeg('KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:yes'), { kind: 'td', ticker: 'KXNFLTD-26OCT25CINBAL-BALDHENRY22-1', game: 'CINBAL', team: 'BAL', player: 'DHENRY', side: 'yes' });
assert.ok(nameMatches('ASTBROWN', 'Amon-Ra St. Brown')); assert.ok(nameMatches('JSMITHNJIGBA', 'Jaxon Smith-Njigba')); assert.ok(!nameMatches('DHENRY', 'Derrick Harmon'));
const pl = (name, team, offers) => ({ name, team, markets: { anytime: { offers: Object.entries(offers).map(([book, price]) => ({ book, price })) } } });
const props = [
  { data: { gameKey: 'CIN|BAL|2026-10-25', players: [pl('Derrick Henry', 'BAL', { draftkings: 120, fanduel: 150, kalshi: 300 })] } },
  { data: { gameKey: 'PIT|NO|2026-10-25', players: [pl('Jaylen Warren', 'PIT', { draftkings: 140, fanduel: 160 })] } },
];
const odds = [{ away_team: 'Cincinnati Bengals', home_team: 'Baltimore Ravens', bookmakers: [{ key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Baltimore Ravens', price: -150 }, { name: 'Cincinnati Bengals', price: 130 }] }] }] }];
const legs = ['KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:yes', 'KXNFLTD-26OCT25PITNO-PITJWARREN30-1:yes'];
// Sold at YES 0.30 (≈ +233) on 100 contracts: risk $70. FanDuel 2.5×2.6 = 6.5 (+550) → arb.
const r = checkFill({ legs, contracts: 100, cost: 70, fee: 0 }, { props, odds });
assert.strictEqual(r.reason, 'arb'); assert.strictEqual(r.best.label, 'FanDuel'); assert.strictEqual(r.best.american, 550);
assert.ok(Math.abs(r.best.stake - 100 / 6.5) < 1e-9);
const hit = r.best.stake * 5.5 - 70; const miss = 100 - 70 - r.best.stake;
assert.ok(Math.abs(hit - miss) < 1e-9 && Math.abs(hit - r.best.locked) < 1e-9 && r.best.locked > 0);
assert.ok(!r.books.some((b) => b.book === 'kalshi'), 'exchanges are not sportsbooks');
const msg = formatArbAlert(r);
assert.ok(msg.includes('alert only') && msg.includes('Book: FanDuel') && msg.includes('Book odds: +550') && msg.includes('Bet: $15.38') && /Locked profit: \$14\.62/.test(msg), msg);
// No arb when the book is shorter than our sold price.
assert.strictEqual(checkFill({ legs, contracts: 100, cost: 85, fee: 0 }, { props, odds }).reason, 'no_arb');
assert.strictEqual(formatArbAlert(checkFill({ legs, contracts: 100, cost: 85, fee: 0 }, { props, odds })), null);
// TD No legs: books don't offer them.
const no = checkFill({ legs: ['KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:no'], contracts: 10, cost: 5 }, { props, odds });
assert.strictEqual(no.hedgeable, false); assert.strictEqual(no.reason, 'td_no_not_offered');
// Same-game flag + moneyline from odds_cache.
const sg = checkFill({ legs: ['KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:yes', 'KXNFLGAME-26OCT25CINBAL-BAL:yes'], contracts: 100, cost: 40 }, { props, odds });
assert.strictEqual(sg.sgp, true); assert.strictEqual(sg.books.length, 1); assert.strictEqual(sg.books[0].book, 'draftkings');
// Watcher: logs a decision, alerts once, re-alerts only on ≥$1 improvement, skips started games.
(async () => {
  const sent = []; const decisions = [];
  const w = createBookArbWatch({ loadData: async () => ({ props, odds }), store: { decision: async (d) => decisions.push(d), openFilledWithLegs: async () => [{ rfq_id: 'a', legs, filled_contracts: 100, filled_cost: 70, filled_fee: 0 }] }, alert: (m) => sent.push(m) });
  await w.check({ rfqId: 'a', legs, contracts: 100, cost: 70, fee: 0 }, 'fill');
  await w.recheckOpen();
  assert.strictEqual(sent.length, 1); assert.strictEqual(decisions.length, 2); assert.strictEqual(decisions[0].action, 'book_arb');
  const w2 = createBookArbWatch({ loadData: async () => ({ props, odds }), store: { decision: async () => {} }, alert: (m) => sent.push(m), kickoffOf: () => 1, now: () => 2 });
  assert.strictEqual(await w2.check({ rfqId: 'b', legs, contracts: 100, cost: 70 }, 'fill'), null);
  console.log('sniper/book-arb.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
