// Sniper-only depth-weighted inverse-bet fair (SNIPER_FAIR_DEPTH_USD, default
// $1,000). Combo Locks' $500-depth / 15% / 15-second rules are NOT touched —
// this module is only used by auto-sniper.
//
// Method per leg (same inverse bet as unhedged-quote, just depth-weighted):
//   1. Opponent markets come from the price cache's opponentQuotes(leg)
//      (Kalshi opponent tickers in the same event).
//   2. Walk the opponent's YES asks (= 1 − its NO bids) until $depth is spent;
//      VWAP = cost / contracts. Book thinner than $depth → leg has no fair.
//   3. Apply the series taker fee (p·(1+θ(1−p))) → fee-included American.
//   4. Best opponent American across opponents, sign-flip → ourTrue YES.
//   5. sideProb honors yes/no. Combo fair = product of legs (independent).
'use strict';
const {
  takerThetaForVenue, applyTakerFeeToProb, ourTrueProb, sideProb, validProb,
} = require('./unhedged-quote');
const { americanFromProb } = require('./engine');

function levelsFrom(arr, scale) {
  return (Array.isArray(arr) ? arr : []).map((l) => {
    const p = Array.isArray(l) ? Number(l[0]) : Number(l.price);
    const q = Array.isArray(l) ? Number(l[1]) : Number(l.quantity || l.qty);
    return [p / scale, q];
  }).filter(([p, q]) => p > 0 && p < 1 && q > 0);
}

// Kalshi GET /markets/{t}/orderbook → YES ask ladder (ascending price).
function yesAsksFromKalshiBook(json) {
  const ob = (json && (json.orderbook_fp || json.orderbook)) || {};
  let noBids = [];
  if (ob.no_dollars) noBids = levelsFrom(ob.no_dollars, 1);
  else if (ob.no) noBids = levelsFrom(ob.no, 100);
  return noBids.map(([p, q]) => [Math.round((1 - p) * 10000) / 10000, q]).sort((a, b) => a[0] - b[0]);
}

// Walk until the opposing bet can WIN $depthUsd (depth = potential profit, not stake — Kevin).
function vwapForDepth(asks, depthUsd) {
  let cost = 0; let qty = 0; let won = 0;
  for (const [p, q] of asks) {
    const per = 1 - p;
    if (!(per > 0)) continue;
    const take = Math.min(q, (depthUsd - won) / per);
    if (take <= 0) break;
    cost += take * p; qty += take; won += take * per;
    if (won >= depthUsd - 1e-6) break;
  }
  if (won < depthUsd - 1e-6 || qty <= 0) return null;
  return cost / qty;
}

function createSniperFair({ kalshiGet, priceCache, depthUsd = 1000, ttlMs = 5000, now = () => Date.now() } = {}) {
  const cache = new Map();
  async function bookAsks(ticker) {
    const hit = cache.get(ticker);
    if (hit && now() - hit.at < ttlMs) return hit.asks;
    const { json } = await kalshiGet(`/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`, 'depth=50');
    const asks = yesAsksFromKalshiBook(json);
    cache.set(ticker, { at: now(), asks });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return asks;
  }
  async function legFair(leg) {
    const quotes = (priceCache && priceCache.opponentQuotes ? priceCache.opponentQuotes(leg) : [])
      .filter((q) => q.venue === 'kalshi' && q.key);
    let best = null;
    for (const q of quotes) {
      const vwap = vwapForDepth(await bookAsks(q.key), depthUsd);
      if (vwap == null) continue;
      const am = americanFromProb(applyTakerFeeToProb(vwap, takerThetaForVenue('kalshi', q.key)));
      if (am != null && (best == null || am > best)) best = am;
    }
    if (best == null) return null;
    return sideProb(ourTrueProb(best), leg && leg.side);
  }
  // Returns legs with fair_yes replaced by the depth fair (null if unavailable).
  async function apply(legs) {
    const out = [];
    for (const l of legs || []) {
      let p = null;
      try { p = validProb(await legFair(l)); } catch (_) { p = null; }
      out.push({ ...l, fair_yes_top: l.fair_yes, fair_yes: p, fair_depth_usd: depthUsd });
    }
    return out;
  }
  return { apply, legFair };
}

module.exports = { createSniperFair, yesAsksFromKalshiBook, vwapForDepth };
