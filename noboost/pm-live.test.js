'use strict';
const assert = require('assert');
const { createPmLiveBook, walk, pxEffective } = require('./pm-live');
let t = 1e12; const now = () => t;
const b = createPmLiveBook({ now });
// game sf vs was, 2026-10-19 (Kalshi ticker date). Kalshi bids: SF ticker no bids 0.22 => SF yes ask .78; WAS ticker no bids .76 => WAS yes ask .24
b.ingestKalshiOrderbooks([
  { ticker: 'KXNFLGAME-26OCT19WASSF-SF', orderbook_fp: { yes_dollars: [['0.77', '100000']], no_dollars: [['0.22', '100000']] } },
  { ticker: 'KXNFLGAME-26OCT19WASSF-WAS', orderbook_fp: { yes_dollars: [['0.23', '100000']], no_dollars: [['0.76', '100000']] } },
]);
b.ingestRelay('novig', [{ bet_type: 'moneyline', away: 'Washington Commanders', home: 'San Francisco 49ers', side: 'Washington Commanders', start: '2026-10-20T00:15:00.000Z', updated_at: new Date(t).toISOString(), depth: [{ odds: 0.225, size: 100 }, { odds: 0.23, size: 100000 }] }], { feedLive: true });
const f = b.legFair('nfl|2026-10-19|sf+was', 'sf');
assert.ok(f && f.p > 0.76 && f.p < 0.78, JSON.stringify(f));
assert.equal(f.best, 'novig');
assert.ok(f.sources.find((s) => s.venue === 'kalshi' && s.via === 'no_own').used);
// stale: advance 16s => all dropped
t += 16000;
const g = b.legFair('nfl|2026-10-19|sf+was', 'sf');
assert.equal(g.p, null); assert.ok(g.sources.every((s) => s.reason === 'stale'));
// depth fail
assert.equal(walk([[0.5, 10]], 'novig').fail, 'depth');
assert.ok(Math.abs(walk([[0.5, 1e6]], 'kalshi').vwap - (0.5 + 0.07 * 0.25)) < 1e-9);
assert.ok(pxEffective(0.5) > 0.5 && pxEffective(0.5) < 0.51);
const c = b.comboFair([{ gameId: 'nfl|2026-10-19|sf+was', team: 'sf' }]);
assert.equal(c.reason, 'no_fresh_source');
assert.equal(b.comboFair([{ kind: 'td' }]).reason, 'td_leg');
console.log('pm-live ok');
{
  // Polymarket US: age = last real change, not "feed up"; settled games skipped.
  let t2 = Date.parse('2026-10-16T17:00:00Z'); const b2 = createPmLiveBook({ now: () => t2 });
  b2.ingestKalshiOrderbooks([
    { ticker: 'KXNFLGAME-26OCT19WASSF-SF', orderbook_fp: { yes_dollars: [['0.77', '100000']], no_dollars: [['0.22', '100000']] } },
    { ticker: 'KXNFLGAME-26OCT19WASSF-WAS', orderbook_fp: { yes_dollars: [['0.23', '100000']], no_dollars: [['0.76', '100000']] } },
  ]);
  const q = (u, odds = 0.225) => ({ bet_type: 'moneyline', feed: 'polymarket-us', away: 'Washington Commanders', home: 'San Francisco 49ers', side: 'Washington Commanders', start: '2026-10-20T00:15:00.000Z', odds, updated_at: u });
  b2.ingestRelay('polymarket', [q(new Date(t2 - 31 * 3600e3).toISOString())], { feedLive: true });
  const pm = b2.legFair('nfl|2026-10-19|sf+was', 'sf').sources.find((s) => s.venue === 'polymarket');
  assert.equal(pm.reason, 'stale');
  // quiet book, price unchanged 31h, but relay confirms the live socket covers it => fresh
  b2.ingestRelay('polymarket', [{ ...q(new Date(t2 - 31 * 3600e3).toISOString()), confirmed_at: new Date(t2 - 1000).toISOString() }]);
  assert.notEqual(b2.legFair('nfl|2026-10-19|sf+was', 'sf').sources.find((s) => s.venue === 'polymarket').reason, 'stale');
  b2.ingestRelay('polymarket', [{ ...q(new Date(t2 - 31 * 3600e3).toISOString()), confirmed_at: new Date(t2 - 16000).toISOString() }]);
  b2.ingestRelay('polymarket', [q(new Date(t2 - 2000).toISOString())], { feedLive: true });
  assert.notEqual(b2.legFair('nfl|2026-10-19|sf+was', 'sf').sources.find((s) => s.venue === 'polymarket').reason, 'stale');
  const b3 = createPmLiveBook({ now: () => t2 });
  assert.equal(b3.ingestRelay('polymarket', [q(new Date(t2).toISOString(), 0.9975)]), 0);
  console.log('pm-live poly-age ok');
}
