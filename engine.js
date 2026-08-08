// Fill-odds lock engine — mirrors src/ComboLocks.jsx decideAtFill exactly.
'use strict';
const KFEE = 0.07;
const aToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const impliedProb = (a) => (a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100));
const feePer = (p, th = KFEE) => th * p * (1 - p);
const r2 = (x) => Math.round(x * 100) / 100;

function decideAtFill({ parlayStake, parlayAmerican, fillAmerican, fairAmerican = null, rfqContracts, maxContracts, scaleFactor = 1 }) {
  if (!(parlayStake > 0) || !parlayAmerican || !fillAmerican || !(rfqContracts > 0)) return { ok: false, reason: 'bad_inputs' };
  const dec = aToDec(parlayAmerican), winReturn = parlayStake * dec, bookHit = winReturn - parlayStake, bookMiss = -parlayStake;
  const cap = (maxContracts != null ? maxContracts : winReturn) * scaleFactor;
  if (rfqContracts > cap + 1e-9) return { ok: false, reason: 'over_limit', cap };
  const N = rfqContracts, s = impliedProb(fillAmerican), fee = N * feePer(s);
  const hit = bookHit + N * s - N - fee, miss = bookMiss + N * s - fee, worst = Math.min(hit, miss);
  return {
    ok: true, locks: worst >= 0, hit: r2(hit), miss: r2(miss), worst: r2(worst),
    competitive: fairAmerican == null ? null : fillAmerican >= fairAmerican, fillAmerican,
    quote: { yes_bid: '0.00', no_bid: r2(1 - s).toFixed(2), rest_remainder: false }, contracts: N,
  };
}
module.exports = { decideAtFill, impliedProb };
