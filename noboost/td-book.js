// NFL player ANYTIME-TD leg prices for the no-boost PAPER run. Read-only, no orders.
//
// Source: Kalshi public orderbooks (GET /markets/orderbooks, unauthenticated, so it does NOT
// spend the shared Kalshi_combo_key's rate limit) for every open KXNFLTD anytime market
// (ticker suffix "-1"), refreshed in the background. The RFQ path is lookup only.
//
// Per-leg fair (Kevin's "inverse bet" + $500 depth convention):
//   noV  = fee-included VWAP to BUY $500 of No  (crosses the Yes bids: No ask = 1 − yes bid)
//   yesV = fee-included VWAP to BUY $500 of Yes (crosses the No bids:  Yes ask = 1 − no bid)
//   fee  = Kalshi taker θ·p·(1−p), θ = 0.07 (KXNFLTD multiplier 1)
//   mid      = yesV / (yesV + noV)            (devig Yes vs No at $500 depth)  -> fair_mid
//   inverse  = 1 − noV                         (sign-flip of the $500 No bet) -> fair_inverse
//   lockCost = yesV                            (cost to rebuild the Yes leg)
// Either side with < $500 of depth, a book older than staleMs, or an overround
// (yesV + noV − 1) above maxOverround => leg unpriceable => the RFQ is skipped.
// A "no" side leg (player NOT to score) swaps Yes/No.
// Polymarket US TD books are NOT blended here: its book endpoint locks out after ~6 calls/10s,
// far too slow for a <15s-fresh paper book. Kalshi only, said so in the row (fair source).
'use strict';
const { parseKalshiUnhedgedTicker } = require('../unhedged-rfq');

const THETA = 0.07;
const DEPTH_USD = 500;
const TD_RE = /^KXNFLTD-([0-9]{2}[A-Z]{3}[0-9]{2}[A-Z]+)-([A-Z0-9]+)-1$/;

const fee = (p) => THETA * p * (1 - p);
// levels: [[askPrice, contracts], ...] best (cheapest) first. VWAP of fee-included cost for $usd.
function vwapFor(levels, usd = DEPTH_USD) {
  let spent = 0; let got = 0;
  for (const [p, q] of levels) {
    if (!(p > 0 && p < 1) || !(q > 0)) continue;
    const c = p + fee(p);
    const take = Math.min(q, (usd - spent) / c);
    spent += take * c; got += take;
    if (spent >= usd - 1e-9) return { vwap: spent / got, top: levels[0][0] + fee(levels[0][0]) };
  }
  return null; // not enough depth
}
// Kalshi orderbook_fp: yes_dollars / no_dollars are BIDS [[price, contracts]].
function laddersFromBook(ob) {
  const b = (ob && (ob.orderbook_fp || ob.orderbook)) || {};
  const rows = (a) => (Array.isArray(a) ? a.map((r) => [Number(r[0]), Number(r[1])]) : []);
  const yesBids = rows(b.yes_dollars); const noBids = rows(b.no_dollars);
  // buy No = cross yes bids (highest yes bid = cheapest No)
  const noAsks = yesBids.map(([p, q]) => [Math.round((1 - p) * 1e4) / 1e4, q]).sort((x, y) => x[0] - y[0]);
  const yesAsks = noBids.map(([p, q]) => [Math.round((1 - p) * 1e4) / 1e4, q]).sort((x, y) => x[0] - y[0]);
  return { yesAsks, noAsks };
}

// "KXNFLTD-26OCT18PITTB-PITKWETJEN10-1" -> { gameId:'nfl|2026-10-18|pit+tb', ticker, player }
function parseTdTicker(ticker) {
  const t = String(ticker || '').toUpperCase();
  const m = TD_RE.exec(t);
  if (!m) return null;
  const pair = m[1].slice(7);
  for (const n of [3, 2, 4]) {
    const team = pair.slice(0, n);
    const p = parseKalshiUnhedgedTicker(`KXNFLGAME-${m[1]}-${team}`, 'yes');
    if (p && !p.skip && p.gameId && p.league === 'nfl') return { gameId: p.gameId, ticker: t, player: m[2], date: p.date };
  }
  return null;
}
const isTdTicker = (t) => TD_RE.test(String(t || '').toUpperCase());

function createTdBook({ now = () => Date.now(), staleMs = 15000, depthUsd = DEPTH_USD, maxOverround = 0.15 } = {}) {
  const books = new Map(); // ticker -> { stats, at, kickoffMs }
  const fails = { depth: 0, stale: 0, overround: 0, missing: 0 };

  function compute(ladders) {
    const y = vwapFor(ladders.yesAsks, depthUsd);
    const n = vwapFor(ladders.noAsks, depthUsd);
    if (!y || !n) return { fail: 'depth' };
    if (y.vwap + n.vwap - 1 > maxOverround) return { fail: 'overround', y, n };
    return { y, n };
  }
  function ingest(orderbooks, meta = {}) {
    let k = 0;
    for (const ob of orderbooks || []) {
      const t = String((ob && (ob.ticker || ob.market_ticker)) || '').toUpperCase();
      if (!isTdTicker(t)) continue;
      books.set(t, { ...compute(laddersFromBook(ob)), at: now(), kickoffMs: meta[t] != null ? meta[t] : (books.get(t) || {}).kickoffMs });
      k += 1;
    }
    return k;
  }
  // stats in the shape quote.priceCombo expects for one leg {id: ticker, side}
  function legStats(leg) {
    const e = books.get(String(leg.id || leg.ticker || '').toUpperCase());
    if (!e) { fails.missing += 1; return null; }
    const age = now() - e.at;
    if (age > staleMs) { fails.stale += 1; return null; }
    if (e.fail) { fails[e.fail] += 1; return null; }
    const own = leg.side === 'no' ? e.n : e.y;
    const opp = leg.side === 'no' ? e.y : e.n;
    return {
      mid: own.vwap / (own.vwap + opp.vwap),
      inverse: 1 - opp.vwap,
      lockCost: own.vwap,
      reference: null,
      promo: null,
      ageMs: age,
      td: { ownVwap: own.vwap, oppVwap: opp.vwap, ownTop: own.top, oppTop: opp.top },
    };
  }
  function kickoffMs(ticker) { const e = books.get(String(ticker).toUpperCase()); return e && Number.isFinite(e.kickoffMs) ? e.kickoffMs : null; }
  function tickers() { return [...books.keys()]; }
  function takeFails() { const f = { ...fails }; for (const k of Object.keys(fails)) fails[k] = 0; return f; }
  return { ingest, legStats, kickoffMs, tickers, takeFails, size: () => books.size, _books: books };
}

module.exports = { createTdBook, parseTdTicker, isTdTicker, vwapFor, laddersFromBook, DEPTH_USD, THETA };
