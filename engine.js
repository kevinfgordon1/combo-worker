// Fill-odds lock engine — mirrors src/ComboLocks.jsx exactly.
'use strict';
// The fill odds you enter are the odds you SELL at AFTER your maker fee — already baked in.
// So the lock math uses them directly (no separate fee term). KFEE/TAKER_FEE are only used to
// recover the nominal exchange price and the taker's matched odds for display.
const KFEE = 0.0175; // your maker fee (¼ of taker); baked into the fill odds you enter
const TAKER_FEE = 0.07; // the taker (other side of your combo) pays this
const aToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const impliedProb = (a) => (a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100));
const americanFromProb = (p) => (!(p > 0 && p < 1) ? null : p < 0.5 ? Math.round((100 * (1 - p)) / p) : -Math.round((100 * p) / (1 - p)));
const r2 = (x) => Math.round(x * 100) / 100;

// Your fill is net of your maker fee. Recover the nominal exchange price you'd quote, and from it
// the taker's matched odds (nominal price + their 7% taker fee — worse than yours).
function nominalProbFromEff(sEff) {
  const b = 1 - KFEE; // solve KFEE*sNom^2 + (1-KFEE)*sNom - sEff = 0
  return (-b + Math.sqrt(b * b + 4 * KFEE * sEff)) / (2 * KFEE);
}
function fillView(fillAfterFeeAmerican) {
  const sEff = impliedProb(fillAfterFeeAmerican);
  const sNom = nominalProbFromEff(sEff);
  const takerProb = sNom + TAKER_FEE * sNom * (1 - sNom);
  return { sEff, sNom, effTaker: americanFromProb(takerProb), noBid: r2(1 - sNom).toFixed(2) };
}

// Contracts cap for a hedge mode. Fill odds already include your maker fee, so no fee term here.
//   riskfree : fewest contracts so the losing (miss) side breaks even (~$0 floor), keeps hit upside
//   1x       : pure hedge — equal payoff whether the combo hits or misses (= stake × decimal boost)
//   2x / 3x  : multiples of the pure hedge — directional short past the hedge (big loss on hit)
function hedgeCap({ stake, boostAmerican, fillAmerican, mode = '1x' }) {
  if (!(stake > 0) || !boostAmerican || !fillAmerican) return 0;
  const winReturn = stake * aToDec(boostAmerican);
  const s = impliedProb(fillAmerican);
  const riskfree = s > 0 ? Math.ceil(stake / s) : 0;
  switch (String(mode)) {
    case 'riskfree': return riskfree;
    case '2x': return Math.round(2 * winReturn);
    case '3x': return Math.round(3 * winReturn);
    case '1x':
    default: return Math.round(winReturn);
  }
}

// Decide the quote at fill time. Fills UP TO the mode's per-fill hedge shape, AND never past the
// parlay's CUMULATIVE ceiling across all prior fills.
//
//   maxContracts : the TOTAL contracts you will ever sell for this parlay (the "limit you put in").
//                  Enforced cumulatively — this is the stop-once-reached ceiling.
//   filledSoFar  : contracts already filled for this parlay (real fills from the DB + any filled
//                  this session). The caller supplies this; the engine just respects it.
//
// remaining = maxContracts - filledSoFar. When remaining <= 0 the RFQ is DECLINED ('limit_reached').
// A partial fill trims N to `remaining` so you land exactly on the ceiling, never past it.
function decideAtFill({ parlayStake, parlayAmerican, fillAmerican, fairAmerican = null, rfqContracts, hedgeMode = '1x', maxContracts = null, filledSoFar = 0 }) {
  if (!(parlayStake > 0) || !parlayAmerican || !fillAmerican || !(rfqContracts > 0)) return { ok: false, reason: 'bad_inputs' };
  const dec = aToDec(parlayAmerican), winReturn = parlayStake * dec, bookHit = winReturn - parlayStake, bookMiss = -parlayStake;
  const cap = hedgeCap({ stake: parlayStake, boostAmerican: parlayAmerican, fillAmerican, mode: hedgeMode }); // per-fill hedge shape
  // Total ceiling: the persisted limit if set, else fall back to the mode's hedge size.
  const totalLimit = (maxContracts != null && maxContracts > 0) ? maxContracts : cap;
  const already = filledSoFar > 0 ? filledSoFar : 0;
  const remainingBefore = Math.max(0, totalLimit - already);
  if (remainingBefore <= 0) {
    return { ok: false, reason: 'limit_reached', cap, totalLimit, filledSoFar: already, remaining: 0 };
  }
  const N = Math.min(rfqContracts, cap, remainingBefore); // never exceed per-fill cap NOR the remaining ceiling
  if (!(N > 0)) return { ok: false, reason: 'zero_cap', cap, totalLimit, filledSoFar: already, remaining: remainingBefore };
  const s = impliedProb(fillAmerican); // already net of your maker fee
  const hit = bookHit + N * s - N, miss = bookMiss + N * s, worst = Math.min(hit, miss);
  const v = fillView(fillAmerican);
  const remainingAfter = remainingBefore - N;
  const trimmedByLimit = N < Math.min(rfqContracts, cap); // this fill was clipped by the cumulative ceiling
  return {
    ok: true, locks: worst >= 0, hit: r2(hit), miss: r2(miss), worst: r2(worst),
    partial: rfqContracts > N, trimmedByLimit, cap, hedgeMode,
    totalLimit, filledSoFar: already, remaining: remainingAfter, limitReached: remainingAfter <= 0,
    competitive: fairAmerican == null ? null : fillAmerican >= fairAmerican, fillAmerican,
    effTakerOdds: v.effTaker,
    quote: { yes_bid: '0.00', no_bid: v.noBid, rest_remainder: false }, contracts: N,
  };
}
module.exports = { decideAtFill, impliedProb, hedgeCap, fillView };
