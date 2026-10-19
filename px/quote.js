// Pure ProphetX parlay math. Leg fair = inverse bet method (unchanged, from
// ../unhedged-quote.js): best $500-depth fee-included opponent American across
// venues, sign-flipped. Parlay fair = product of independent legs. Offer =
// fair × combo wrap margin (DEFAULT_QUOTE_MULT, 1.05) so the participant gets
// slightly worse than fair. Leg probabilities sent at confirm are our fair
// legs, scaled so their product reconstructs the MIRROR of confirmed_price.
'use strict';
const { americanFromProb } = require('../engine');
const { DEFAULT_QUOTE_MULT, validProb } = require('../unhedged-quote');

const STALE_MS = 15_000; // Kevin's 15-second rule: older leg prices are not quoted.
const MIN_LEGS = 2;
const MAX_LEGS = 8;

function impliedFromAmerican(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 0) return 100 / (n + 100);
  return -n / (-n + 100);
}

// Participant-side American for probability q, rounded in OUR favor
// (never pays more than q implies).
function participantAmericanFloor(q) {
  const p = validProb(q);
  if (p == null) return null;
  if (p < 0.5) return Math.floor((100 * (1 - p)) / p);
  return -Math.ceil((100 * p) / (1 - p));
}

// Decline reasons are plain strings; null means quotable.
function screenLegs(lines, { known, nowMs = Date.now(), minLegs = MIN_LEGS, maxLegs = MAX_LEGS } = {}) {
  if (!Array.isArray(lines) || lines.length < minLegs) return 'too_few_legs';
  if (lines.length > maxLegs) return 'too_many_legs';
  const events = new Set();
  const strikes = new Set();
  for (const l of lines) {
    const sid = l && (l.strike_id || l.line_id);
    if (!sid) return 'leg_without_strike';
    if (strikes.has(sid)) return 'duplicate_leg';
    strikes.add(sid);
    const info = known && known.get(sid);
    if (!info) return 'unsupported_leg';
    const ev = String(l.sport_event_id || info.eventId);
    if (events.has(ev)) return 'correlated_same_game';
    events.add(ev);
    if (info.startMs && info.startMs <= nowMs) return 'game_started';
  }
  return null;
}

// legs: [{strike_id, p, at}] where p = our fair prob for that leg (inverse method).
function priceParlay(legs, { nowMs = Date.now(), margin = DEFAULT_QUOTE_MULT, staleMs = STALE_MS } = {}) {
  if (!Array.isArray(legs) || !legs.length) return { decline: 'no_legs' };
  let fair = 1;
  for (const l of legs) {
    const p = validProb(l && l.p);
    if (p == null) return { decline: 'leg_unpriced' };
    if (!(l.at > 0) || nowMs - l.at > staleMs) return { decline: 'leg_stale' };
    fair *= p;
  }
  const m = Number.isFinite(margin) && margin > 1 && margin < 2 ? margin : DEFAULT_QUOTE_MULT;
  const quoteP = fair * m;
  if (!(fair > 0) || !(quoteP < 0.98)) return { decline: 'price_out_of_range' };
  const participant = participantAmericanFloor(quoteP);
  if (participant == null) return { decline: 'price_out_of_range' };
  // Per-leg display price: spread the margin evenly across legs (participant side).
  const legM = m ** (1 / legs.length);
  const estimated = legs.map((l) => ({ strike_id: l.strike_id, price: participantAmericanFloor(Math.min(0.99, l.p * legM)) }));
  return {
    decline: null,
    fairP: fair,
    quoteP,
    fairAmerican: americanFromProb(fair),
    participantAmerican: participant,
    estimated,
  };
}

// Docs: the product of strikes[].probability must reconstruct the implied
// probability of the MIRROR of confirmed_price (confirmed +4146 → target is
// implied(−4146)... the docs' own example; sign handled generically: target =
// implied(−confirmed_price)).
function mirrorTarget(confirmedPrice) {
  const n = Number(confirmedPrice);
  if (!Number.isFinite(n) || n === 0) return null;
  return impliedFromAmerican(-n);
}

// Scale fair legs by a common factor so Π p'_i = target exactly (ratio
// preserved). Returns null if any leg would leave (0,1).
function legProbabilities(legs, target) {
  const t = validProb(target);
  if (t == null || !Array.isArray(legs) || !legs.length) return null;
  const fair = legs.reduce((a, l) => a * l.p, 1);
  if (!(fair > 0)) return null;
  const k = (t / fair) ** (1 / legs.length);
  const out = legs.map((l) => ({ strike_id: l.strike_id, probability: l.p * k }));
  if (out.some((x) => !(x.probability > 0 && x.probability < 1))) return null;
  // Remove floating drift on the last leg so the product is exact.
  const prodButLast = out.slice(0, -1).reduce((a, x) => a * x.probability, 1);
  out[out.length - 1].probability = t / prodButLast;
  if (!(out[out.length - 1].probability > 0 && out[out.length - 1].probability < 1)) return null;
  return out;
}

function nsFromNow(ms, nowMs = Date.now()) {
  return (BigInt(Math.floor(nowMs + ms)) * 1000000n).toString();
}

module.exports = {
  STALE_MS, MIN_LEGS, MAX_LEGS,
  impliedFromAmerican, participantAmericanFloor, screenLegs, priceParlay,
  mirrorTarget, legProbabilities, nsFromNow,
};
