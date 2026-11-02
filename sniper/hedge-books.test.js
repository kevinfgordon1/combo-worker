'use strict';
// Hedge-cost own-side readers on the NFL ML (pm-live), lines and player-TD books (log-only).
const assert = require('assert');
const { createPmLiveBook } = require('../noboost/pm-live');
const { createTdBook } = require('../noboost/td-book');
const L = require('./lines');
const H = require('./hedge-cost');
const { ALL_VENUES } = require('./fair');
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const KF = (p) => 0.07 * p * (1 - p);

{ // NFL moneyline: SF own side = SF Yes ask .78 or WAS No ask (1 − .23 yes bid = .77); Novig SF side $0 fee
  let t = 1e12; const b = createPmLiveBook({ now: () => t });
  b.ingestKalshiOrderbooks([
    { ticker: 'KXNFLGAME-26OCT19WASSF-SF', orderbook_fp: { yes_dollars: [['0.77', '100000']], no_dollars: [['0.22', '100000']] } },
    { ticker: 'KXNFLGAME-26OCT19WASSF-WAS', orderbook_fp: { yes_dollars: [['0.23', '100000']], no_dollars: [['0.76', '100000']] } },
  ]);
  const gid = 'nfl|2026-10-19|sf+was';
  let h = H.legHedge(b.legFair(gid, 'sf').hedgeSources(), ALL_VENUES);
  assert.strictEqual(h.v, 'kalshi'); assert.strictEqual(h.x.kalshi.via, 'no_opp'); assert.ok(near(h.c, 0.77 + KF(0.77)), JSON.stringify(h));
  assert.strictEqual(h.x.novig.r, 'missing');
  b.ingestRelay('novig', [{ bet_type: 'moneyline', away: 'Washington Commanders', home: 'San Francisco 49ers', side: 'San Francisco 49ers', start: '2026-10-20T00:15:00.000Z', updated_at: new Date(t).toISOString(), depth: [{ odds: 0.775, size: 100000 }] }], { feedLive: true });
  h = H.legHedge(b.legFair(gid, 'sf').hedgeSources(), ALL_VENUES);
  assert.strictEqual(h.v, 'novig'); assert.ok(near(h.c, 0.775), 'Novig: no fee pregame');
  t += 16000;
  h = H.legHedge(b.legFair(gid, 'sf').hedgeSources(), ALL_VENUES);
  assert.strictEqual(h.c, null); assert.strictEqual(h.x.novig.r, 'stale'); assert.strictEqual(h.x.kalshi.r, 'stale');
}

{ // lines: GB −7.5 own = Kalshi Yes ask .55+fee vs Novig GB −7.5 at .50
  const SP = 'KXNFLSPREAD-26OCT29CARGB-GB8';
  const t = 1e12; const book = L.createLinesBook({ now: () => t, depthUsd: 2000 });
  book.addGamesFromTickers([SP]);
  const q = (o) => ({ league: 'NFL', away: 'Carolina Panthers', home: 'Green Bay Packers', start: '2026-10-29T17:00:00Z', updated_at: new Date(t).toISOString(), is_alt: false, ...o });
  book.ingestRelay('novig', 'nfl', [
    q({ bet_type: 'spread', side: 'Green Bay Packers', line: -7.5, odds: 0.5, depth: [{ odds: 0.5, size: 10000 }] }),
    q({ bet_type: 'spread', side: 'Carolina Panthers', line: 7.5, odds: 0.52, depth: [{ odds: 0.52, size: 10000 }] }),
  ]);
  book.ingestKalshiOrderbooks([{ ticker: SP, orderbook_fp: { no_dollars: [[0.45, 10000]], yes_dollars: [[0.40, 10000]] } }]);
  const f = book.legFair(L.classifyLineLeg(`${SP}:yes`));
  const h = H.legHedge(f.hedgeSources(), ALL_VENUES);
  assert.strictEqual(h.v, 'novig'); assert.ok(near(h.c, 0.5)); assert.ok(near(h.x.kalshi.c, 0.55 + KF(0.55)));
  assert.ok(near(f.p, 0.48), 'fair unchanged');
}

{ // player TD: Yes leg own side = buy Yes; No leg own side = buy No; overround / stale carried as reasons
  let t = 1e12; const td = createTdBook({ now: () => t, depthUsd: 500, maxOverround: 0.15 });
  const T = 'KXNFLTD-26OCT25CINBAL-BALDHENRY22-1';
  td.ingest([{ ticker: T, orderbook_fp: { yes_dollars: [['0.38', '100000']], no_dollars: [['0.58', '100000']] } }]);
  const y = td.legMulti({ id: T, side: 'yes' }); const n = td.legMulti({ id: T, side: 'no' });
  const hy = H.legHedge(y.hedgeSources(), ALL_VENUES); const hn = H.legHedge(n.hedgeSources(), ALL_VENUES);
  assert.ok(near(hy.c, 0.42 + KF(0.42)), JSON.stringify(hy)); assert.ok(near(hn.c, 0.62 + KF(0.62)), JSON.stringify(hn));
  assert.ok(near(y.p, 1 - (0.62 + KF(0.62))), 'TD fair unchanged (inverse of the No side)');
  assert.strictEqual(hy.x.kalshi.via, 'td_own');
  t += 16000; assert.strictEqual(H.legHedge(td.legMulti({ id: T, side: 'yes' }).hedgeSources(), ALL_VENUES).x.kalshi.r, 'stale');
}
console.log('sniper/hedge-books.test.js ok');
