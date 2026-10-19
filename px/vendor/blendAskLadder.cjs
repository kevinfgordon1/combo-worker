// VENDORED from aibetbuilder origin/main 768ea81 src/blendAskLadder.js (ESM→CJS, logic unchanged).
"use strict";
// Walk a prediction-market ask ladder for Promo true-odds / Profit Boost.
//
// Liquidity / true-odds walk (1-leg and multi-leg):
//   VWAP-walk until PROFIT (win excluding the original stake) reaches
//   TARGET_PAYOUT_USD ($500). Same bar for Profit Boost (incl. 0%), Free Bet,
//   and No Sweat. "Payout" in UI copy is this profit, not face/total return
//   (stake + win). Incomplete walk → lowLiquidity. Sportsbooks never flag.
//
// Top-of-book gate (Hide low liquidity):
//   The best American price band alone must also fund $500 profit. Deeper,
//   worse levels may still shape VWAP when the top is deep enough, but a
//   thin top (e.g. $64 on a -2000 No) cannot clear Hide low liquidity by
//   walking into junk/resting depth behind it — and must not claim
//   "blended to $500 payout".
//
// Lock math is separate: requiredBoostHedgeStake / freebet / nosweat hedge $
//   still describe the perfect-lock stake for Guaranteed Profit. That is not
//   the Hide-low-liquidity completeness bar. Example: $100 stake, +200 boosted
//   100% → $400 win; opp −200 needs $333.33 hedge — but $500 profit still
//   decides whether the inverse book is liquid enough to show.
//
// Size on depth levels is DOLLAR STAKE (price × contracts). See lib/book-depth.js.
// Profit = stake × (decimalOdds − 1):
//   american > 0: stake × (american / 100)
//   american < 0: stake × (100 / |american|)
// Never invents levels. Sportsbooks are left untouched.
// A PM venue with no ladder and no bestOppSize has no proven fill → lowLiquidity.
// Do not treat "unknown book" as OK; Hide low liquidity relies on that tag.
// True odds / true win prob / EV use the blended VWAP American, not the thin top.
// "blended to $500 payout" / "blended to $X hedge" only when the walk used
// more than one price level (or VWAP ≠ top). A deep top that fills alone
// is not a blend — omit the tag. Shortfall copy still always shows.

const { oppQuoteLooksInverted, quoteLooksWrongSideOf } = require("./promoOppGuard.cjs");

const TARGET_PAYOUT_USD = 500;
const PM_BLEND_VENUES = new Set(["kalshi", "polymarket", "novig", "prophetx"]);
const LOW_LIQUIDITY_LABEL = "Low liquidity";
const COMPLETE_EPS = 0.5;

function isPmBlendVenue(bookKey) {
  return PM_BLEND_VENUES.has(String(bookKey || "").toLowerCase());
}

function americanToImpliedProb(american) {
  const n = typeof american === "number" ? american : Number(american);
  if (!isFinite(n) || n === 0) return null;
  if (n < 0) return Math.abs(n) / (Math.abs(n) + 100);
  return 100 / (n + 100);
}

function impliedProbToAmerican(p) {
  if (p == null || !isFinite(p) || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return -Math.round((100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

function americanToDecimal(american) {
  const n = typeof american === "number" ? american : Number(american);
  if (!isFinite(n) || n === 0) return null;
  if (n > 0) return 1 + n / 100;
  return 1 + 100 / Math.abs(n);
}

// Profit excluding stake per $1 staked. Face/total return is this + 1.
function americanToProfitMultiple(american) {
  const d = americanToDecimal(american);
  if (d == null || d <= 1) return null;
  return d - 1;
}

function stakeToProfit(stake, american) {
  const s = Number(stake);
  const m = americanToProfitMultiple(american);
  if (!(s > 0) || m == null) return null;
  return s * m;
}

function formatPayoutDollars(n) {
  if (!isFinite(n) || n <= 0) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function formatHedgeDollars(n) {
  if (!isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) < 0.005) return `$${rounded.toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

function payoutTargetLabel(target = TARGET_PAYOUT_USD) {
  return formatPayoutDollars(target) || `$${TARGET_PAYOUT_USD}`;
}

// True blending = walked into additional/worse prices (or VWAP ≠ the quoted top).
// A single deep top that already fills the $500-profit target is not a blend.
function blendDidWalk(blend, topAmerican) {
  if (!blend) return false;
  // A blend can only be worse than the top. VWAP better than (or equal to)
  // the quoted top is not a walk — never label it "blended".
  if (topAmerican != null && Number.isFinite(Number(topAmerican)) && Number(topAmerican) !== 0
    && blend.american != null && Number.isFinite(Number(blend.american))) {
    return Number(blend.american) < Number(topAmerican);
  }
  return Number(blend.levelsUsed) > 1;
}

function formatBlendedPayoutFlag(blend, topAmerican) {
  if (!blend || blend.american == null) return "";
  const target = payoutTargetLabel(blend.targetPayout ?? TARGET_PAYOUT_USD);
  // Thin top: never claim a full $500 fill even if worse levels could fund it.
  if (blend.complete && !blend.thinTop) {
    if (!blendDidWalk(blend, topAmerican)) return "";
    return `blended to ${target} payout`;
  }
  const filledProfit = blend.thinTop && blend.topProfitFilled != null
    ? blend.topProfitFilled
    : blend.payoutFilled;
  const filled = formatPayoutDollars(filledProfit);
  if (!filled) return `blended · $0 of ${target} payout available`;
  return `blended · ${filled} of ${target} payout available`;
}

function formatBlendedHedgeFlag(blend, topAmerican) {
  if (!blend || blend.american == null) return "";
  const target = formatHedgeDollars(blend.targetStake);
  if (blend.complete) {
    if (!blendDidWalk(blend, topAmerican)) return "";
    return target ? `blended to ${target} hedge` : "blended to hedge";
  }
  const filled = formatHedgeDollars(blend.stakeFilled);
  if (!target) return "blended · hedge short";
  if (!filled) return `blended · $0 of ${target} hedge available`;
  return `blended · ${filled} of ${target} hedge available`;
}

function normalizeLevels(levels) {
  const clean = [];
  for (const raw of levels || []) {
    const american = typeof raw?.american === "number" ? raw.american : Number(raw?.american);
    const size = typeof raw?.size === "number" ? raw.size : parseFloat(raw?.size);
    if (!isFinite(american) || american === 0 || !isFinite(size) || size <= 0) continue;
    const p = americanToImpliedProb(american);
    if (p == null || p <= 0 || p >= 1) continue;
    clean.push({ american, size, p });
  }
  clean.sort((a, b) => b.american - a.american);
  return clean;
}

// Sum dollar stake at the best American only (ties after normalize). Hide low
// liquidity requires this band to fund TARGET_PAYOUT_USD profit by itself.
function topBandCoversTarget(levels, targetPayout = TARGET_PAYOUT_USD) {
  const target = Number(targetPayout);
  if (!isFinite(target) || target <= 0) return false;
  const ladder = normalizeLevels(levels);
  if (!ladder.length) return false;
  const topAm = ladder[0].american;
  let size = 0;
  for (const lvl of ladder) {
    if (lvl.american !== topAm) break;
    size += lvl.size;
  }
  const profit = stakeToProfit(size, topAm);
  return profit != null && profit + COMPLETE_EPS >= target;
}

function finishBlend({ stakeFilled, payoutFilled, levelsUsed, complete, targetPayout, targetStake, mode }) {
  if (!(payoutFilled > 0) || !(stakeFilled > 0)) return null;
  // Payout-mode `payoutFilled` is profit (excl. stake). Hedge-mode keeps face
  // (stake / impliedProb) so VWAP is still stake / face either way.
  const face = mode === "payout" ? stakeFilled + payoutFilled : payoutFilled;
  if (!(face > 0)) return null;
  const impliedProb = stakeFilled / face;
  const american = impliedProbToAmerican(impliedProb);
  if (american == null) return null;
  const blend = {
    american,
    impliedProb,
    stakeFilled,
    payoutFilled,
    targetPayout: targetPayout ?? null,
    targetStake: targetStake ?? null,
    complete,
    levelsUsed,
    mode: mode || "payout",
    lowLiquidity: !complete,
  };
  blend.flag = blend.mode === "hedge" ? formatBlendedHedgeFlag(blend) : formatBlendedPayoutFlag(blend);
  return blend;
}

function blendAskLadderToPayout(levels, { targetPayout = TARGET_PAYOUT_USD } = {}) {
  const target = Number(targetPayout);
  if (!isFinite(target) || target <= 0) return null;
  const ladder = normalizeLevels(levels);
  if (!ladder.length) return null;

  let payoutFilled = 0;
  let stakeFilled = 0;
  let levelsUsed = 0;

  for (const lvl of ladder) {
    const remaining = target - payoutFilled;
    if (remaining <= 1e-9) break;
    // profit = stake × (1 − p) / p  (= stake × (decimalOdds − 1))
    const profitPerStake = (1 - lvl.p) / lvl.p;
    if (!(profitPerStake > 0)) continue;
    const levelProfit = lvl.size * profitPerStake;
    const takeProfit = Math.min(levelProfit, remaining);
    const takeStake = takeProfit / profitPerStake;
    payoutFilled += takeProfit;
    stakeFilled += takeStake;
    levelsUsed += 1;
  }

  const complete = payoutFilled + COMPLETE_EPS >= target;
  return finishBlend({
    stakeFilled,
    payoutFilled: complete ? Math.min(payoutFilled, target) : payoutFilled,
    levelsUsed,
    complete,
    targetPayout: target,
    mode: "payout",
  });
}

// Walk until cumulative STAKE (hedge $) is filled. Size on each level is already stake $.
function blendAskLadderToStake(levels, { targetStake } = {}) {
  const target = Number(targetStake);
  if (!isFinite(target) || target <= 0) return null;
  const ladder = normalizeLevels(levels);
  if (!ladder.length) return null;

  let payoutFilled = 0;
  let stakeFilled = 0;
  let levelsUsed = 0;

  for (const lvl of ladder) {
    const remaining = target - stakeFilled;
    if (remaining <= 1e-9) break;
    if (!(lvl.size > 0)) continue;
    const takeStake = Math.min(lvl.size, remaining);
    const takePayout = takeStake / lvl.p;
    stakeFilled += takeStake;
    payoutFilled += takePayout;
    levelsUsed += 1;
  }

  const complete = stakeFilled + COMPLETE_EPS >= target;
  return finishBlend({
    stakeFilled: complete ? Math.min(stakeFilled, target) : stakeFilled,
    payoutFilled,
    levelsUsed,
    complete,
    targetStake: target,
    mode: "hedge",
  });
}

function boostedProfitFromLeg(leg, stake, boostPct) {
  const S = Number(stake);
  const pct = Number(boostPct);
  const d = americanToDecimal(leg && leg.dk);
  if (!(S > 0) || !isFinite(pct) || d == null || d <= 1) return null;
  return (d - 1) * S * (1 + pct / 100);
}

// H = (boostedProfit + stake) / d_h   — same as calcBoostLock.
function requiredBoostHedgeStake(stake, boostedProfit, oppAmerican) {
  const S = Number(stake);
  const profit = Number(boostedProfit);
  const d_h = americanToDecimal(oppAmerican);
  if (!(S > 0) || !(profit > 0) || d_h == null || d_h <= 1) return null;
  return (profit + S) / d_h;
}

// H = (d_fb − 1) × FB / d_h   — same as calcFreeBetConversion.
function requiredFreeBetHedgeStake(fbAmerican, oppAmerican, freeBetAmount) {
  const fb = Number(freeBetAmount);
  const d_fb = americanToDecimal(fbAmerican);
  const d_h = americanToDecimal(oppAmerican);
  if (!(fb > 0) || d_fb == null || d_fb <= 1 || d_h == null || d_h <= 1) return null;
  return (d_fb - 1) * fb / d_h;
}

// H = (winProfit + stake − creditValue) / d_h   — same as calcNoSweatLock.
function requiredNoSweatHedgeStake(stake, winProfit, creditValue, oppAmerican) {
  const S = Number(stake);
  const profit = Number(winProfit);
  const V = Number(creditValue);
  const d_h = americanToDecimal(oppAmerican);
  if (!isFinite(S) || !isFinite(profit) || !isFinite(V) || d_h == null || d_h <= 1) return null;
  const H = (profit + S - V) / d_h;
  return H > 0 ? H : null;
}

function resolvePmBookLevels(leg, levels) {
  if (!isPmBlendVenue(leg && leg.bestOppBook)) return [];
  const ladder = normalizeLevels(levels);
  if (ladder.length) return ladder;
  // Cached No ladder carried on the leg (player TD legs from the props cron).
  const stored = normalizeLevels(leg.bestOppLevels);
  if (stored.length) return stored;
  const quoted = leg.bestOppQuoted != null ? leg.bestOppQuoted : leg.bestOpp;
  const size = typeof leg.bestOppSize === "number" ? leg.bestOppSize : parseFloat(leg.bestOppSize);
  if (!isFinite(quoted) || quoted === 0 || !isFinite(size) || size <= 0) return [];
  return normalizeLevels([{ american: quoted, size }]);
}

// Blended VWAP when the book was walked; otherwise the quoted bestOpp.
function trueOppAmerican(leg) {
  const blended = leg && leg.pmBlend && leg.pmBlend.american;
  if (blended != null && isFinite(Number(blended)) && Number(blended) !== 0) return Number(blended);
  const n = Number(leg && leg.bestOpp);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function applyPmBlendToLeg(leg, levels, ctx = {}) {
  if (!leg || !isPmBlendVenue(leg.bestOppBook)) {
    return { ...leg, lowLiquidity: false, pmBlend: null };
  }
  const quoted = leg.bestOppQuoted != null ? leg.bestOppQuoted : leg.bestOpp;
  const book = resolvePmBookLevels(leg, levels);
  // Empty ladder and missing/invalid bestOppSize: no proven $500-profit
  // fill. Rank + Hide-low-liquidity must not treat this as OK —
  // the live depth overlay would later badge LOW LIQUIDITY.
  if (!book.length) {
    return { ...leg, bestOppQuoted: quoted, lowLiquidity: true, pmBlend: null };
  }

  // 1-leg boost / freebet / nosweat use the same $500 inverse-payout walk
  // as multi-leg. Hedge $ stays on lock math (quoted opp), not this bar.
  const blend = blendAskLadderToPayout(book);

  if (!blend || blend.american == null) {
    return { ...leg, bestOppQuoted: quoted, lowLiquidity: true, pmBlend: null };
  }

  // Hide low liquidity: top American band must fund $500 profit alone.
  // Deeper levels must not launder a $64 top into "blended to $500".
  const topOk = topBandCoversTarget(book);
  if (!topOk) {
    const topAm = book[0].american;
    const topBand = book.filter((l) => l.american === topAm);
    const topBlend = blendAskLadderToPayout(topBand) || blend;
    const thin = {
      ...topBlend,
      complete: false,
      lowLiquidity: true,
      thinTop: true,
      topProfitFilled: topBlend.payoutFilled,
      // Keep full-ladder VWAP off the card when the top cannot clear the bar.
      american: quoted,
      impliedProb: americanToImpliedProb(quoted),
      flag: undefined,
    };
    thin.flag = formatBlendedPayoutFlag(thin, quoted);
    if (oppQuoteLooksInverted(leg.dk, thin.american) || quoteLooksWrongSideOf(quoted, thin.american)) {
      return { ...leg, bestOppQuoted: quoted, bestOpp: quoted, lowLiquidity: true, pmBlend: null };
    }
    return {
      ...leg,
      bestOppQuoted: quoted,
      bestOpp: quoted,
      lowLiquidity: true,
      pmBlend: thin,
    };
  }

  // Wrong-side depth (favorite ladder walked as the dog inverse) must not
  // replace a sane quoted opp with +2000-class "true" odds.
  if (oppQuoteLooksInverted(leg.dk, blend.american) || quoteLooksWrongSideOf(quoted, blend.american)) {
    return { ...leg, bestOppQuoted: quoted, bestOpp: quoted, lowLiquidity: !!blend.lowLiquidity, pmBlend: null };
  }
  return {
    ...leg,
    bestOppQuoted: quoted,
    bestOpp: blend.american,
    lowLiquidity: !!blend.lowLiquidity,
    pmBlend: blend,
  };
}

// Legs that carry their own No ladder (player TDs from the props cron) are
// blended before the parlay scan, so the scan ranks on the same $500 fair
// the card shows. Other legs keep top-of-book until the page depth fetch.
function preBlendStoredLadderLegs(legs, ctx = {}) {
  return (legs || []).map((leg) => {
    if (!leg || !Array.isArray(leg.bestOppLevels) || !leg.bestOppLevels.length) return leg;
    const blended = applyPmBlendToLeg(leg, null, ctx);
    return blended && blended.pmBlend ? blended : leg;
  });
}

function applyPmBlendToLegs(legs, laddersByKey, ctx = {}) {
  const blends = {};
  const displayLegs = (legs || []).map((leg) => {
    const key = [
      leg && leg.bestOppBook,
      leg && leg.sport,
      leg && leg.game,
      (leg && (leg.bestOppName || leg.name)) || "",
      leg && leg.market,
    ].join("|");
    const levels = laddersByKey && laddersByKey[key];
    const next = applyPmBlendToLeg(leg, levels, {
      ...ctx,
      numLegs: ctx.numLegs != null ? ctx.numLegs : (legs || []).length,
    });
    if (next.pmBlend) blends[key] = next.pmBlend;
    return next;
  });
  return { displayLegs, blends };
}

function pickHasLowLiquidity(legs) {
  return (legs || []).some((l) => l && l.lowLiquidity);
}

// Full hedge/payout fill ranks ahead of a short book; EV is the tie-breaker.
function preferCompletePmHedge(parlays) {
  return [...(parlays || [])].sort((a, b) => {
    const aFull = !pickHasLowLiquidity(a && a.legs);
    const bFull = !pickHasLowLiquidity(b && b.legs);
    if (aFull !== bFull) return aFull ? -1 : 1;
    return (Number(b && b.ev) || 0) - (Number(a && a.ev) || 0);
  });
}

module.exports = { TARGET_PAYOUT_USD, PM_BLEND_VENUES, LOW_LIQUIDITY_LABEL, isPmBlendVenue, americanToImpliedProb, impliedProbToAmerican, americanToDecimal, americanToProfitMultiple, stakeToProfit, formatPayoutDollars, formatHedgeDollars, payoutTargetLabel, blendDidWalk, formatBlendedPayoutFlag, formatBlendedHedgeFlag, topBandCoversTarget, blendAskLadderToPayout, blendAskLadderToStake, boostedProfitFromLeg, requiredBoostHedgeStake, requiredFreeBetHedgeStake, requiredNoSweatHedgeStake, resolvePmBookLevels, trueOppAmerican, applyPmBlendToLeg, preBlendStoredLadderLegs, applyPmBlendToLegs, pickHasLowLiquidity, preferCompletePmHedge };
