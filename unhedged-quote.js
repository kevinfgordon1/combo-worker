// Unhedged RFQ shadow quote math — independent of Combo Locks / engine KFEE.
// Do not POST from this module. Fair is the product of independent YES probs
// (honor yes/no).
//
// Would-quote YES = margin × net_cost, then the first penny at or above that
// (Kevin: fair 0.10 MLB → fee 0.00315 → net 0.10315 → 0.1083 → 0.11).
// net_cost = fair YES + Kalshi combo maker fee (if any). Polymarket maker
// cost is 0 — rebates are ignored and never baked into the quote.
'use strict';
const { americanFromProb } = require('./engine');

const KALSHI_COMBO_MAKER = 0.035;
const KALSHI_NFL_MAKER = 0;
const POLY_MAKER_RATE = 0; // rebates ignored; never bake rebate income into the quote
const DEFAULT_QUOTE_MULT = 1.05;

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function validProb(p) {
  return p != null && p > 0 && p < 1 ? p : null;
}

function floor2(x) {
  return Math.floor(x * 100 + 1e-9) / 100;
}

// First cent at or above x. 0.1083 → 0.11 (true floor would be 0.10).
function ceil2(x) {
  return Math.ceil(x * 100 - 1e-9) / 100;
}

function quoteMultFromEnv(env = process.env) {
  const n = numOrNull(env && env.UNHEDGED_QUOTE_MULT);
  if (n == null) return DEFAULT_QUOTE_MULT;
  return n > 1 && n < 2 ? n : DEFAULT_QUOTE_MULT;
}

function isUnhedgedRfqLive(env = process.env) {
  const v = env && env.UNHEDGED_RFQ_LIVE;
  if (v == null || String(v).trim() === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function makerFee(p, rate) {
  const prob = validProb(p);
  if (prob == null || !Number.isFinite(rate) || rate === 0) return 0;
  return rate * prob * (1 - prob);
}

function isKalshiNflOnly(legs) {
  if (!Array.isArray(legs) || !legs.length) return false;
  return legs.every((leg) => String(leg && leg.league || '').toLowerCase() === 'nfl');
}

function kalshiMakerRate(legs) {
  return isKalshiNflOnly(legs) ? KALSHI_NFL_MAKER : KALSHI_COMBO_MAKER;
}

function venueMakerRate(venue, legs) {
  if (venue === 'polymarket') return POLY_MAKER_RATE;
  if (venue === 'kalshi') return kalshiMakerRate(legs);
  return null;
}

function netCostFromFair(fairYes, feeRate) {
  const fair = validProb(fairYes);
  if (fair == null) return null;
  const net = fair + makerFee(fair, feeRate);
  return net > 0 && net < 1 ? net : null;
}

function quoteYesFromFair(fairYes, { feeRate = 0, margin = DEFAULT_QUOTE_MULT } = {}) {
  const net = netCostFromFair(fairYes, feeRate);
  if (net == null) return null;
  const mult = Number.isFinite(margin) && margin > 1 && margin < 2 ? margin : DEFAULT_QUOTE_MULT;
  return validProb(ceil2(mult * net));
}

function sideProb(yesProb, side) {
  const p = validProb(yesProb);
  if (p == null) return null;
  const s = String(side || 'yes').toLowerCase();
  if (s === 'no') return validProb(1 - p);
  if (s === 'yes') return p;
  return null;
}

function productFair(probs) {
  if (!Array.isArray(probs) || !probs.length) return null;
  let acc = 1;
  for (const p of probs) {
    const v = validProb(p);
    if (v == null) return null;
    acc *= v;
  }
  return validProb(acc);
}

function priceUnhedgedCombo({ venue, legs, getYesProb, margin = DEFAULT_QUOTE_MULT } = {}) {
  const empty = { our_fair_american: null, our_quote_american: null, fairYes: null, quoteYes: null };
  if (!venue || !Array.isArray(legs) || !legs.length) return empty;
  if (typeof getYesProb !== 'function') return empty;

  const feeRate = venueMakerRate(venue, legs);
  if (feeRate == null) return empty;

  const probs = [];
  for (const leg of legs) {
    const key = venue === 'kalshi'
      ? (leg && (leg.ticker || leg.symbol))
      : (leg && (leg.symbol || leg.ticker));
    if (!key) return empty;
    const yes = getYesProb(venue, key, leg);
    const p = sideProb(yes, leg && leg.side);
    if (p == null) return empty;
    probs.push(p);
  }

  const fairYes = productFair(probs);
  const netCost = netCostFromFair(fairYes, feeRate);
  const quoteYes = quoteYesFromFair(fairYes, { feeRate, margin });
  const fairAm = americanFromProb(fairYes);
  const quoteAm = americanFromProb(quoteYes);
  if (fairAm == null || quoteAm == null) return empty;
  return {
    our_fair_american: fairAm,
    our_quote_american: quoteAm,
    fairYes,
    quoteYes,
    netCost,
    feeRate,
  };
}

module.exports = {
  KALSHI_COMBO_MAKER,
  KALSHI_NFL_MAKER,
  POLY_MAKER_RATE,
  DEFAULT_QUOTE_MULT,
  isUnhedgedRfqLive,
  quoteMultFromEnv,
  makerFee,
  isKalshiNflOnly,
  kalshiMakerRate,
  venueMakerRate,
  netCostFromFair,
  quoteYesFromFair,
  sideProb,
  productFair,
  priceUnhedgedCombo,
  validProb,
  floor2,
  ceil2,
};
