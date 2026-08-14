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
// Floor to the cent — never round NO bid UP past the fill target (we buy NO / sell the parlay).
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
// Kalshi REST quotes require FixedPointDollars (two decimal places). Bare "0" is
// invalid_yes_bid / invalid_dollar_precision. We buy NO; YES is "0.00".
const YES_DECLINE = '0.00';

function yesBidForQuote(yesBid) {
  if (yesBid == null || yesBid === '' || Number(yesBid) === 0) return YES_DECLINE;
  const s = String(yesBid);
  return s === '0' ? YES_DECLINE : s;
}

function buildQuoteBody(rfqId, noBid, yesBid, restRemainder) {
  return {
    rfq_id: rfqId,
    yes_bid: yesBidForQuote(yesBid),
    no_bid: noBid,
    rest_remainder: restRemainder,
  };
}

// Post when we have a positive contract count — from contracts_fp, or a dollar-RFQ
// estimate (target_cost / yesPrice). Oversized RFQs are still declined later by
// decideAtFill (rfq_too_large). Maker quotes have no size; Kalshi fills the full RFQ.
function shouldPostQuote(size) {
  return !!(size && size.contracts > 0 && (size.source === 'contracts' || size.source === 'dollar'));
}

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
  // Penny grid: floor no_bid so effective sell odds are never worse than fillAfterFeeAmerican.
  // (Nearest-cent rounding turned +1100 into no_bid 0.92 ≈ +1170 after fee.)
  return { sEff, sNom, effTaker: americanFromProb(takerProb), noBid: floor2(1 - sNom).toFixed(2) };
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
// IMPORTANT: Kalshi maker quotes have NO size — accepting our quote fills the FULL RFQ.
// So we must DECLINE when rfqContracts > remaining (cannot "partial quote"). Same for
// rfqContracts > per-fill hedge cap.
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
  // Full-RFQ-only venue: never quote if the RFQ is larger than we can still sell.
  if (rfqContracts > remainingBefore) {
    return {
      ok: false, reason: 'rfq_too_large', cap, totalLimit, filledSoFar: already,
      remaining: remainingBefore, rfqContracts,
    };
  }
  if (rfqContracts > cap) {
    return {
      ok: false, reason: 'rfq_too_large', cap, totalLimit, filledSoFar: already,
      remaining: remainingBefore, rfqContracts,
    };
  }
  const N = rfqContracts; // quote size == RFQ size (only path Kalshi supports)
  if (!(N > 0)) return { ok: false, reason: 'zero_cap', cap, totalLimit, filledSoFar: already, remaining: remainingBefore };
  const s = impliedProb(fillAmerican); // already net of your maker fee
  const hit = bookHit + N * s - N, miss = bookMiss + N * s, worst = Math.min(hit, miss);
  const v = fillView(fillAmerican);
  const remainingAfter = remainingBefore - N;
  return {
    ok: true, locks: worst >= 0, hit: r2(hit), miss: r2(miss), worst: r2(worst),
    partial: false, trimmedByLimit: false, cap, hedgeMode,
    totalLimit, filledSoFar: already, remaining: remainingAfter, limitReached: remainingAfter <= 0,
    competitive: fairAmerican == null ? null : fillAmerican >= fairAmerican, fillAmerican,
    effTakerOdds: v.effTaker,
    quote: { yes_bid: YES_DECLINE, no_bid: v.noBid, rest_remainder: false }, contracts: N,
  };
}
module.exports = {
  decideAtFill, impliedProb, hedgeCap, fillView, americanFromProb,
  YES_DECLINE, yesBidForQuote, buildQuoteBody, shouldPostQuote,
};
