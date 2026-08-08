// Fill-odds lock engine — mirrors src/ComboLocks.jsx decideAtFill exactly.
'use strict';
// MAKER fee coefficient. You are the quoter/maker on combo (KXMVE) RFQs, and per Kalshi's
// fee schedule + the RFQ fee filing (eff. 2026-07-24) the accepted quoter pays the MAKER fee
// = 0.0175 × C × P × (1−P) — one quarter of the 0.07 taker fee. Confirmed vs kalshi.com fee PDF.
const KFEE = 0.0175;
const aToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const TAKER_FEE = 0.07; // the RFQ taker (person taking your combo) pays this
const impliedProb = (a) => (a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100));
const feePer = (p, th = KFEE) => th * p * (1 - p);
const r2 = (x) => Math.round(x * 100) / 100;
const americanFromProb = (p) => (!(p > 0 && p < 1) ? null : p < 0.5 ? Math.round((100 * (1 - p)) / p) : -Math.round((100 * p) / (1 - p)));
// Fill odds with fees baked in, from your nominal fill (american).
//   effMaker : the odds YOU are truly laying the combo at once your 1.75% maker fee is included
//   effTaker : the odds the TAKER actually receives after their 7% taker fee (competitiveness gauge)
function effectiveOdds(fillAmerican) {
  const P = impliedProb(fillAmerican);
  return { effMaker: americanFromProb(P - feePer(P, KFEE)), effTaker: americanFromProb(P + feePer(P, TAKER_FEE)) };
}

// Contracts cap for a hedge mode — derived from stake + boosted odds + fill odds.
//   riskfree : fewest contracts so the LOSING (miss) side breaks even (~$0 floor), keeps hit upside
//   1x       : pure hedge — equal payoff whether the combo hits or misses (= stake * decimal boost)
//   2x / 3x  : multiples of the pure hedge. NOTE these OVERSHOOT the hedge into a directional short
//              (profit if the combo misses, large loss if it hits). Kept as an explicit choice.
function hedgeCap({ stake, boostAmerican, fillAmerican, mode = '1x' }) {
  if (!(stake > 0) || !boostAmerican || !fillAmerican) return 0;
  const winReturn = stake * aToDec(boostAmerican); // pure hedge = total return if the book bet wins
  const s = impliedProb(fillAmerican);
  const denom = s * (1 - KFEE * (1 - s));
  const riskfree = denom > 0 ? Math.ceil(stake / denom) : 0; // min N so miss >= 0
  switch (String(mode)) {
    case 'riskfree': return riskfree;
    case '2x': return Math.round(2 * winReturn);
    case '3x': return Math.round(3 * winReturn);
    case '1x':
    default: return Math.round(winReturn);
  }
}

// Decide the quote at fill time. Fills UP TO the mode's cap (partial fill on bigger RFQs).
function decideAtFill({ parlayStake, parlayAmerican, fillAmerican, fairAmerican = null, rfqContracts, hedgeMode = '1x' }) {
  if (!(parlayStake > 0) || !parlayAmerican || !fillAmerican || !(rfqContracts > 0)) return { ok: false, reason: 'bad_inputs' };
  const dec = aToDec(parlayAmerican), winReturn = parlayStake * dec, bookHit = winReturn - parlayStake, bookMiss = -parlayStake;
  const cap = hedgeCap({ stake: parlayStake, boostAmerican: parlayAmerican, fillAmerican, mode: hedgeMode });
  const N = Math.min(rfqContracts, cap); // partial fill: a bigger RFQ fills to the cap, not rejected
  if (!(N > 0)) return { ok: false, reason: 'zero_cap', cap };
  const s = impliedProb(fillAmerican), fee = N * feePer(s);
  const hit = bookHit + N * s - N - fee, miss = bookMiss + N * s - fee, worst = Math.min(hit, miss);
  const eff = effectiveOdds(fillAmerican);
  return {
    ok: true, locks: worst >= 0, hit: r2(hit), miss: r2(miss), worst: r2(worst),
    partial: rfqContracts > cap, cap, hedgeMode,
    competitive: fairAmerican == null ? null : fillAmerican >= fairAmerican, fillAmerican,
    effMakerFill: eff.effMaker, effTakerOdds: eff.effTaker,
    quote: { yes_bid: '0.00', no_bid: r2(1 - s).toFixed(2), rest_remainder: false }, contracts: N,
  };
}
module.exports = { decideAtFill, impliedProb, hedgeCap, effectiveOdds };
