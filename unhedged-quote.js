// Unhedged RFQ shadow quote math — independent of Combo Locks / engine KFEE.
// Do not POST from this module. Fair is the product of independent YES probs
// (honor yes/no). Would-quote applies venue fee, then a YES cushion, then
// floors to the penny.
'use strict';
const { americanFromProb } = require('./engine');

const KALSHI_COMBO_MAKER = 0.035;
const KALSHI_NFL_MAKER = 0;
const POLY_MAKER_REBATE = 0.0125;
const DEFAULT_CUSHION_YES = 0.05;

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

function cushionYesFromEnv(env = process.env) {
  const n = numOrNull(env && env.UNHEDGED_CUSHION_YES);
  if (n == null) return DEFAULT_CUSHION_YES;
  return n >= 0 && n < 1 ? n : DEFAULT_CUSHION_YES;
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
  if (venue === 'polymarket') return -POLY_MAKER_REBATE;
  if (venue === 'kalshi') return kalshiMakerRate(legs);
  return null;
}

function quoteYesFromFair(fairYes, { feeRate = 0, cushion = DEFAULT_CUSHION_YES } = {}) {
  const fair = validProb(fairYes);
  if (fair == null) return null;
  const fee = makerFee(fair, feeRate);
  const raw = fair - fee - cushion;
  const floored = floor2(raw);
  return validProb(floored);
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

function priceUnhedgedCombo({ venue, legs, getYesProb, cushion = DEFAULT_CUSHION_YES } = {}) {
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
  const quoteYes = quoteYesFromFair(fairYes, { feeRate, cushion });
  const fairAm = americanFromProb(fairYes);
  const quoteAm = americanFromProb(quoteYes);
  if (fairAm == null || quoteAm == null) return empty;
  return {
    our_fair_american: fairAm,
    our_quote_american: quoteAm,
    fairYes,
    quoteYes,
    feeRate,
  };
}

module.exports = {
  KALSHI_COMBO_MAKER,
  KALSHI_NFL_MAKER,
  POLY_MAKER_REBATE,
  DEFAULT_CUSHION_YES,
  isUnhedgedRfqLive,
  cushionYesFromEnv,
  makerFee,
  isKalshiNflOnly,
  kalshiMakerRate,
  venueMakerRate,
  quoteYesFromFair,
  sideProb,
  productFair,
  priceUnhedgedCombo,
  validProb,
  floor2,
};
