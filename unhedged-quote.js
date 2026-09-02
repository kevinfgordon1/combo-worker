// Unhedged RFQ shadow quote math — independent of Combo Locks / engine KFEE.
// Do not POST from this module. Fair is the product of independent ourTrue
// probs (honor yes/no). Inverse (opponent MLs): convert opponent YES to a
// fee-included American using the *series taker* coeff (hitting the ask =
// taker). Kalshi 2026-09-02: KXMLBGAME multiplier 0.5 → θ=0.035; KXNFLGAME
// and KXNCAAFGAME multiplier 1 → θ=0.07. Polymarket US taker Θ=0.06 (ignore
// maker rebate). Best opponent American across Kalshi vs Poly, then sign-flip.
// Kevin: Mariners 45¢ on KXMLBGAME → 0.035×0.45×0.55 ≈ 0.0087 → 0.4587 →
// +118, invert Sox −118. Full 0.07 haircut to +114 is wrong for MLB GAME.
//
// Combo WRAP (unchanged, Combos row is separate): NFL-only maker 0;
// MLB/NCAAF/mixed 0.035*p*(1-p). Polymarket maker 0, no rebate. Then
// 1.05 * net_cost, first penny up.
'use strict';
const { americanFromProb } = require('./engine');

const KALSHI_COMBO_MAKER = 0.035; // Combos row: 50% of Kalshi taker 0.07
const KALSHI_NFL_MAKER = 0;
const POLY_MAKER_RATE = 0; // rebates ignored; never bake rebate income into the quote
const DEFAULT_QUOTE_MULT = 1.05;
const KALSHI_TAKER_BASE = 0.07;
const KALSHI_TAKER_THETA = 0.07; // multiplier 1 (NFL / NCAAF / most markets)
const KALSHI_MLB_TAKER_THETA = 0.035; // KXMLBGAME 0.5 × 0.07
const POLY_TAKER_THETA = 0.06; // docs.polymarket.us/fees taker Θ; ignore rebate

// Captured kalshi.com/fee-schedule 2026-09-02 + series API fee_multiplier.
// Do not invent a third sport: only these GAME moneylines.
const KALSHI_SERIES_TAKER_MULTIPLIER = {
  KXMLBGAME: 0.5,
  KXNFLGAME: 1,
  KXNCAAFGAME: 1, // series API fee_multiplier=1; not listed as 0.5
};

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

// Promo Builder / EV: trueProb is implied of an already-fee-included American.
// ourTrue = 1 − that = sign-flip of the American. No extra theta at invert.
// Missing opponent is null here (do not invent 0.5).
function trueProb(bestOpponentOdds) {
  if (bestOpponentOdds == null || bestOpponentOdds === '') return null;
  const n = Number(bestOpponentOdds);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n < 0) return Math.abs(n) / (Math.abs(n) + 100);
  return 100 / (n + 100);
}

function ourTrueProb(bestOpponentOdds) {
  const tp = trueProb(bestOpponentOdds);
  return tp == null ? null : validProb(1 - tp);
}

// Sign-flip of a fee-included American: +118 → -118, -140 → +140.
function invertAmerican(american) {
  if (american == null || american === '') return null;
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return null;
  return -n;
}

function kalshiSeriesTicker(text) {
  const s = String(text || '').trim().toUpperCase();
  if (!s) return '';
  const colon = s.lastIndexOf(':');
  const ticker = colon === -1 ? s : s.slice(0, colon);
  const dash = ticker.indexOf('-');
  return dash > 0 ? ticker.slice(0, dash) : ticker;
}

function kalshiTakerTheta(seriesOrTicker) {
  if (seriesOrTicker == null || seriesOrTicker === '') return KALSHI_TAKER_THETA;
  const raw = String(seriesOrTicker).trim().toLowerCase();
  if (raw === 'mlb') return KALSHI_MLB_TAKER_THETA;
  if (raw === 'nfl' || raw === 'ncaaf') return KALSHI_TAKER_THETA;
  const series = kalshiSeriesTicker(seriesOrTicker);
  const mult = KALSHI_SERIES_TAKER_MULTIPLIER[series];
  if (mult == null) return KALSHI_TAKER_THETA;
  return KALSHI_TAKER_BASE * mult;
}

function takerThetaForVenue(venue, seriesOrTicker) {
  if (venue === 'polymarket') return POLY_TAKER_THETA;
  if (venue === 'kalshi') return kalshiTakerTheta(seriesOrTicker);
  return null;
}

// p_eff = p + θ·p·(1−p) = p × (1 + θ·(1−p)). Hitting opponent ask = taker.
function applyTakerFeeToProb(p, theta) {
  const raw = validProb(p);
  if (raw == null) return null;
  if (!Number.isFinite(theta)) return null;
  return validProb(raw * (1 + theta * (1 - raw)));
}

function feeIncludedAmerican(rawYes, theta) {
  return americanFromProb(applyTakerFeeToProb(rawYes, theta));
}

function opponentAmericanFromQuote(q) {
  if (!q) return null;
  if (q.american != null && q.american !== '') {
    const n = Number(q.american);
    return Number.isFinite(n) && n !== 0 ? n : null;
  }
  const hint = q.series || q.ticker || q.key || q.league;
  const theta = q.theta != null ? q.theta : takerThetaForVenue(q.venue, hint);
  if (theta == null) return null;
  const raw = q.yesProb != null ? q.yesProb : q.p;
  return feeIncludedAmerican(raw, theta);
}

function ourTrueFromOpponentYes(rawYes, theta) {
  const am = feeIncludedAmerican(rawYes, theta);
  return am == null ? null : ourTrueProb(am);
}

// Best opponent American for someone betting the opponent: more plus / less minus.
function bestOpponentAmerican(quotes) {
  let best = null;
  for (const q of quotes || []) {
    const am = opponentAmericanFromQuote(q);
    if (am == null) continue;
    if (best == null || am > best) best = am;
  }
  return best;
}

// Lowest fee-included YES implied by the best opponent American (no 2nd theta).
function bestOpponentEff(quotes) {
  const am = bestOpponentAmerican(quotes);
  return am == null ? null : trueProb(am);
}

function ourTrueFromOpponents(quotes) {
  const am = bestOpponentAmerican(quotes);
  return am == null ? null : ourTrueProb(am);
}

function priceUnhedgedCombo({ venue, legs, getOurTrue, getYesProb, margin = DEFAULT_QUOTE_MULT } = {}) {
  const empty = { our_fair_american: null, our_quote_american: null, fairYes: null, quoteYes: null };
  if (!venue || !Array.isArray(legs) || !legs.length) return empty;
  if (typeof getOurTrue !== 'function' && typeof getYesProb !== 'function') return empty;

  const feeRate = venueMakerRate(venue, legs);
  if (feeRate == null) return empty;

  const probs = [];
  for (const leg of legs) {
    let yes = null;
    if (typeof getOurTrue === 'function') {
      yes = getOurTrue(leg);
    } else {
      const key = venue === 'kalshi'
        ? (leg && (leg.ticker || leg.symbol))
        : (leg && (leg.symbol || leg.ticker));
      if (!key) return empty;
      yes = getYesProb(venue, key, leg);
    }
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
  KALSHI_TAKER_BASE,
  KALSHI_TAKER_THETA,
  KALSHI_MLB_TAKER_THETA,
  KALSHI_SERIES_TAKER_MULTIPLIER,
  POLY_TAKER_THETA,
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
  trueProb,
  ourTrueProb,
  invertAmerican,
  kalshiSeriesTicker,
  kalshiTakerTheta,
  takerThetaForVenue,
  applyTakerFeeToProb,
  feeIncludedAmerican,
  opponentAmericanFromQuote,
  ourTrueFromOpponentYes,
  bestOpponentAmerican,
  bestOpponentEff,
  ourTrueFromOpponents,
  priceUnhedgedCombo,
  validProb,
  floor2,
  ceil2,
};
