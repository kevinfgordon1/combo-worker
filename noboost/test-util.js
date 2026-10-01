// test helper: build a fake NFL book from {game:'26OCT04ARINYG', a:'ARI', b:'NYG', askA, askB, bidA, bidB}
'use strict';
const { createNflBook } = require('./book');
function mk(game, team, ask, bid, occ) {
  return { ticker: `KXNFLGAME-${game}-${team}`, yes_ask_dollars: String(ask), yes_bid_dollars: String(bid), occurrence_datetime: occ };
}
function makeBook(games, now = () => Date.now()) {
  const book = createNflBook({ now });
  const mkts = [];
  for (const g of games) {
    const occ = g.occ || new Date(Date.now() + 24 * 3600e3 + 3 * 3600e3).toISOString();
    mkts.push(mk(g.game, g.a, g.askA, g.bidA, occ), mk(g.game, g.b, g.askB, g.bidB, occ));
  }
  book.ingestKalshiMarkets(mkts);
  return book;
}
module.exports = { makeBook };
