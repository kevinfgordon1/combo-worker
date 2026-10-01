'use strict';
const assert = require('assert');
const { createNflBook, KICKOFF_OFFSET_MS } = require('./book');

let t = 1e12;
const book = createNflBook({ now: () => t, staleMs: 15000 });
const occ = '2026-10-04T23:25:00Z';
const n = book.ingestKalshiMarkets([
  { ticker: 'KXNFLGAME-26OCT04DENSF-DEN', yes_ask_dollars: '0.40', yes_bid_dollars: '0.38', occurrence_datetime: occ },
  { ticker: 'KXNFLGAME-26OCT04DENSF-SF', yes_ask_dollars: '0.62', yes_bid_dollars: '0.60', occurrence_datetime: occ },
  { ticker: 'KXNBAGAME-26OCT04LALBOS-LAL', yes_ask_dollars: '0.5', occurrence_datetime: occ },
  { ticker: 'KXNFLGAME-26OCT04ARINYG-ARI', yes_ask_dollars: '0', yes_bid_dollars: '0', occurrence_datetime: occ },
]);
assert.strictEqual(n, 3, 'non-NFL ignored');
const [gid] = book.games()[0];
assert.strictEqual(book.kickoffMs(gid), Date.parse(occ) - KICKOFF_OFFSET_MS, 'kickoff = occurrence - 3h');
assert.strictEqual(KICKOFF_OFFSET_MS, 3 * 3600e3);
// opposite side quotes
const opp = book.opponentQuotes({ gameId: gid, team: 'den' });
assert.strictEqual(opp.length, 1);
assert.strictEqual(opp[0].yesProb, 0.62);
assert.strictEqual(book.ownQuotes({ gameId: gid, team: 'den' })[0].yesProb, 0.40);
// stale quotes disappear
t += 16000;
assert.strictEqual(book.opponentQuotes({ gameId: gid, team: 'den' }).length, 0);
// zero ask treated as no quote
const [gid2] = book.games().filter(([k]) => /ari/.test(k))[0];
assert.strictEqual(book.ownQuotes({ gameId: gid2, team: 'ari' }).length, 0);
// reference
book.setReference(gid, 'den', 0.41);
assert.strictEqual(book.source.reference({ gameId: gid, team: 'den' }), 0.41);
console.log('noboost-book.test.js ok');
