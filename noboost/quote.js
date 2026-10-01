// No-boost RFQ combo quoter — PURE pricing math. PAPER / SHADOW ONLY.
//
// Nothing here does I/O, posts, confirms or cancels. Reuses the Combo Locks /
// Unhedged "inverse bet" helpers (unhedged-quote.js: ourTrueFromOpponents,
// venue taker thetas, americanFromProb). Does NOT import or modify engine.js
// quoting paths (engine.js is only read for americanFromProb / impliedProb).
//
// Scope: UNCORRELATED NFL MONEYLINE parlays only (every leg a different
// KXNFLGAME / Poly aec-nfl game, all moneylines). Everything else is a skip.
//
// ── Formula (documented; margin is NOBOOST_MARGIN, default 0.10) ─────────────
// We SELL the parlay: taker pays y per $1 payout, we collect y and pay $1 if
// every leg hits. Per contract our EV = y − P (P = true all-legs-hit prob).
//   1. Per-leg true prob  p_i = ourTrue(leg)  = 1 − impliedProb(best fee-included
//      opponent American)   [the "inverse bet": Kalshi / Poly opposite side at
//      the posted ASK + that venue's taker θ·p·(1−p), best American across
//      venues, then sign-flip]. Same function Unhedged/Promo Builder use.
//   2. Combo fair   P = Π p_i   (legs are in different games ⇒ independent).
//   3. Target price y_target = P·(1 + m)          (marginMode 'price', default)
//        ⇒ EV/contract = m·P, i.e. we keep m (10%) of the true price; the
//          taker overpays by 10% vs true.
//      marginMode 'capital': solve (y − P)/(1 − y) = m ⇒ y = (P + m)/(1 + m)
//        (EV as % of the collateral 1−y we lock up). Far less competitive.
//   4. Inventory skew: m_eff = m·(1 + skew·util), util∈[0,1] from risk book.
//   5. Lock guardrail (default ON): y_lock = Π ask_i, ask_i = cheapest
//      fee-included OWN-side ask across Kalshi/Poly = what it costs to buy the
//      parlay's legs back. We never quote below y_lock:
//        y_quote = max(y_target, y_lock)  — so a quote is always lockable at ≥ 0
//      (hedge is optional: Kevin may hold +EV unhedged). NB: inverse-based P is
//      the LOW estimate of true (it is the bid-side of each leg); y_lock is the
//      HIGH estimate. Truth sits between; the backtest reports all three.
//   6. Tick: y rounded UP (never undercut our own target) to 0.001 (0.0001 when
//      subcent=true and y<0.01). American odds are derived from the final y.
'use strict';
const { americanFromProb } = require('../engine');
const {
  validProb, productFair, ourTrueFromOpponents, feeIncludedAmerican,
  applyTakerFeeToProb, takerThetaForVenue, bestOpponentAmerican, kalshiMakerRate,
  POLY_MAKER_RATE,
} = require('../unhedged-quote');

const DEFAULTS = Object.freeze({
  margin: 0.10,
  marginMode: 'price',
  fairMethod: 'inverse',
  guardrail: 'lock',
  minLegs: 2,
  maxLegs: 10,
  tick: 0.001,
  subcent: false,
  skew: 1,
  twoSided: false,
  refMaxDev: 0,
});

function num(raw, fb, lo = -Infinity, hi = Infinity) {
  if (raw == null || String(raw).trim() === '') return fb;
  const n = Number(raw);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fb;
}
function flag(raw, fb = false) {
  if (raw == null || String(raw).trim() === '') return fb;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fb;
}
function pick(raw, allowed, fb) {
  const s = raw == null ? '' : String(raw).trim().toLowerCase();
  return allowed.includes(s) ? s : fb;
}

// Master switch. Default OFF everywhere.
function isNoBoostShadow(env = process.env) {
  return flag(env && env.NOBOOST_SHADOW, false);
}
// Posting is NOT wired in this module; the flag exists so nobody wires it by accident.
function isNoBoostLive(env = process.env) {
  return flag(env && env.NOBOOST_LIVE, false);
}

function configFromEnv(env = process.env) {
  const e = env || {};
  return {
    margin: num(e.NOBOOST_MARGIN, DEFAULTS.margin, 0, 5),
    marginMode: pick(e.NOBOOST_MARGIN_MODE, ['price', 'capital'], DEFAULTS.marginMode),
    fairMethod: pick(e.NOBOOST_FAIR_METHOD, ['inverse', 'mid', 'promo'], DEFAULTS.fairMethod),
    guardrail: pick(e.NOBOOST_GUARDRAIL, ['lock', 'off'], DEFAULTS.guardrail),
    minLegs: Math.floor(num(e.NOBOOST_MIN_LEGS, DEFAULTS.minLegs, 2, 40)),
    maxLegs: Math.floor(num(e.NOBOOST_MAX_LEGS, DEFAULTS.maxLegs, 2, 40)),
    tick: num(e.NOBOOST_TICK, DEFAULTS.tick, 0.0001, 0.01),
    subcent: flag(e.NOBOOST_SUBCENT, DEFAULTS.subcent),
    skew: num(e.NOBOOST_SKEW, DEFAULTS.skew, 0, 10),
    twoSided: flag(e.NOBOOST_TWO_SIDED, DEFAULTS.twoSided),
    refMaxDev: num(e.NOBOOST_REF_MAX_DEV, DEFAULTS.refMaxDev, 0, 0.5),
  };
}

function ceilTo(x, tick) { return Math.ceil(x / tick - 1e-9) * tick; }
function floorTo(x, tick) { return Math.floor(x / tick + 1e-9) * tick; }
function r4(x) { return Math.round(x * 1e4) / 1e4; }

function tickFor(y, cfg) {
  if (cfg.subcent && y < 0.01) return 0.0001;
  return cfg.tick || DEFAULTS.tick;
}

// Fee-included cost (per $1 payout) of BUYING a leg at a posted ask.
function costWithFee(askProb, venue, hint) {
  // Sportsbook price (already vig-inclusive implied prob, no exchange fee).
  if (venue === 'book') return validProb(askProb);
  const theta = takerThetaForVenue(venue, hint);
  if (theta == null) return null;
  return applyTakerFeeToProb(askProb, theta);
}

// Per-leg numbers from a price source.
//   source.opponentQuotes(leg) -> [{venue, yesProb, key, theta?}]   (opponent ASK, YES prob)
//   source.ownQuotes(leg)      -> [{venue, yesProb, key}]            (this leg's own ASK)
//   source.reference(leg)      -> optional no-vig prob (e.g. Pinnacle) for diagnostics
// Returns null when the leg cannot be priced (never invents a price).
// Pure leg math from venue quotes (opp = opposite side asks, own = this side asks).
function priceLegFromQuotes(opp, own, referenceProb) {
  const inverse = ourTrueFromOpponents(opp);
  if (inverse == null) return null;
  let lockCost = null;
  let lockVenue = null;
  for (const q of own) {
    const c = costWithFee(q.yesProb, q.venue, q.key || q.ticker || q.venue);
    if (c != null && (lockCost == null || c < lockCost)) { lockCost = c; lockVenue = q.venue; }
  }
  // Mid no-vig of the book pair (diagnostic / alt fair): venue mids of own and opposite
  // side, normalised so they sum to 1. Uses bids when the source has them, else asks.
  const midOf = (qs) => {
    if (!qs.length) return null;
    const best = qs.reduce((a, q) => (q.yesProb < a.yesProb ? q : a), qs[0]);
    return best.bid != null && best.bid > 0 && best.bid <= best.yesProb ? (best.bid + best.yesProb) / 2 : best.yesProb;
  };
  const ownMid = midOf(own);
  const oppMid = midOf(opp);
  const mid = (ownMid != null && oppMid != null && ownMid > 0 && oppMid > 0)
    ? validProb(ownMid / (ownMid + oppMid)) : null;
  return {
    inverse, lockCost, lockVenue, mid, reference: validProb(referenceProb),
    oppAmerican: bestOpponentAmerican(opp),
  };
}

// Per-leg numbers from a price source.
//   source.legStats(leg)       -> PRECOMPUTED cached stats (+ ageMs) — the fast RFQ path (no I/O, no recompute)
//   else:
//   source.opponentQuotes(leg) -> [{venue, yesProb, key, theta?}]   (opponent ASK, YES prob)
//   source.ownQuotes(leg)      -> [{venue, yesProb, key}]            (this leg's own ASK)
//   source.reference(leg)      -> optional no-vig prob (e.g. Pinnacle) for diagnostics
// Returns null when the leg cannot be priced (never invents a price).
function priceLeg(leg, source) {
  if (!source) return null;
  if (typeof source.legStats === 'function') return source.legStats(leg) || null;
  if (typeof source.opponentQuotes !== 'function') return null;
  const own = typeof source.ownQuotes === 'function' ? (source.ownQuotes(leg) || []) : [];
  return priceLegFromQuotes(source.opponentQuotes(leg) || [], own,
    typeof source.reference === 'function' ? source.reference(leg) : null);
}

// target price for fair prob P and margin m (before skew/guardrail/tick)
function targetPrice(P, m, mode = 'price') {
  if (!(P > 0 && P < 1) || !(m >= 0)) return null;
  if (mode === 'capital') return (P + m) / (1 + m);
  return P * (1 + m);
}

// Sell-side price for a full combo.
//   legs   : leg objects accepted by `source`
//   opts   : { cfg, util (0..1) }
// Returns { ok, reason?, ...numbers }. ALL american fields are American odds.
function priceCombo(legs, source, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
  const util = Math.max(0, Math.min(1, Number(opts.util) || 0));
  const venue = opts.venue || 'kalshi';
  if (!Array.isArray(legs) || legs.length < cfg.minLegs) return { ok: false, reason: 'too_few_legs' };
  if (legs.length > cfg.maxLegs) return { ok: false, reason: 'too_many_legs' };

  const per = [];
  for (const leg of legs) {
    const p = priceLeg(leg, source);
    if (!p) return { ok: false, reason: 'unpriceable_leg', leg: leg && (leg.ticker || leg.symbol) };
    // promo method needs the trusted-book consensus; the exchange-only methods need a fresh exchange book
    if (cfg.fairMethod === 'promo' ? !(p.promo && p.promo.consensus != null) : p.inverse == null) {
      return { ok: false, reason: cfg.fairMethod === 'promo' ? 'no_promo_consensus' : 'unpriceable_leg', leg: leg && (leg.ticker || leg.symbol) };
    }
    per.push(p);
  }
  const fairInverse = per.every((p) => p.inverse != null) ? productFair(per.map((p) => p.inverse)) : null;
  const fairMid = per.every((p) => p.mid != null) ? productFair(per.map((p) => p.mid)) : null;
  const lockProbs = per.map((p) => p.lockCost);
  const yLock = lockProbs.every((x) => x != null && x !== undefined) ? productFair(lockProbs) : null;
  const fairRef = per.every((p) => p.reference != null) ? productFair(per.map((p) => p.reference)) : null;
  // PROMO: Promo-Builder-style trusted-book + exchange consensus (noboost/promo-fair.js), precomputed
  // in the book by a background refresher; legs without a fresh consensus make the combo unpriceable.
  const fairPromo = per.every((p) => p.promo && p.promo.consensus != null) ? productFair(per.map((p) => p.promo.consensus)) : null;
  const fairPromoBest = per.every((p) => p.promo && p.promo.promoBest != null) ? productFair(per.map((p) => p.promo.promoBest)) : null;
  const fair = cfg.fairMethod === 'mid' ? fairMid : (cfg.fairMethod === 'promo' ? fairPromo : fairInverse);
  if (fair == null) return { ok: false, reason: 'no_fair' };

  if (cfg.refMaxDev > 0 && fairRef != null && Math.abs(fair - fairRef) / fairRef > cfg.refMaxDev) {
    return { ok: false, reason: 'ref_disagrees', fair, fairRef };
  }

  const mEff = cfg.margin * (1 + cfg.skew * util);
  const feeRate = venue === 'polymarket' ? POLY_MAKER_RATE : kalshiMakerRate(legs.map(() => ({ league: 'nfl' })));
  // Maker fee on NFL-only Kalshi combos is 0; keep the term so a non-zero rate cannot be forgotten.
  const feeAdj = feeRate ? feeRate * fair * (1 - fair) : 0;
  const yTarget = targetPrice(fair + feeAdj, mEff, cfg.marginMode);
  if (yTarget == null) return { ok: false, reason: 'bad_target' };

  let y = yTarget;
  let binding = false;
  if (cfg.guardrail === 'lock') {
    if (yLock == null) return { ok: false, reason: 'no_lock_price' };
    if (yLock > y) { y = yLock; binding = true; }
  }
  const tick = tickFor(y, cfg);
  const yq = r4(ceilTo(y, tick));
  if (!(yq >= tick && yq <= 0.99)) return { ok: false, reason: 'price_out_of_range', y: yq };

  // Buy-side bid (optional): we BUY the parlay from a taker who sells it. EV = P − yb.
  let yBid = null;
  if (cfg.twoSided) {
    const base = cfg.marginMode === 'capital' ? (fair - cfg.margin) / (1 - cfg.margin) : fair / (1 + mEff);
    const lockBid = cfg.guardrail === 'lock' ? productFair(per.map((p) => p.inverse)) : null;
    let b = base;
    if (lockBid != null && lockBid < b) b = lockBid;
    const bt = tickFor(b, cfg);
    b = r4(floorTo(b, bt));
    yBid = b >= bt ? b : null;
  }

  return {
    ok: true,
    legs: per.length,
    fair, fairMid, fairPromo, fairPromoBest, fairRef, yLock, yTarget, mEff, binding,
    legAgesMs: per.map((p) => (p.ageMs == null ? null : Math.round(p.ageMs))),
    maxLegAgeMs: per.reduce((a, p) => { const g = cfg.fairMethod === 'promo' ? (p.promo && p.promo.ageMs) : p.ageMs; return g != null && g > a ? g : a; }, 0),
    quoteYes: yq,
    noBid: r4(1 - yq),
    yesBid: yBid,
    edgeVsFair: yq / fair - 1,
    evPerContract: yq - fair,
    // American odds (never percentages) — the only odds fields the logger prints.
    fair_american: americanFromProb(fair),
    fair_inverse_american: fairInverse == null ? null : americanFromProb(fairInverse),
    fair_mid_american: fairMid == null ? null : americanFromProb(fairMid),
    fair_promo_american: fairPromo == null ? null : americanFromProb(fairPromo),
    fair_promo_best_american: fairPromoBest == null ? null : americanFromProb(fairPromoBest),
    promoAgeMs: per.reduce((a, p) => (p.promo && p.promo.ageMs != null && p.promo.ageMs > a ? p.promo.ageMs : a), 0),
    promoBooks: per.map((p) => (p.promo ? p.promo.n : 0)),
    ref_american: fairRef == null ? null : americanFromProb(fairRef),
    lock_american: yLock == null ? null : americanFromProb(yLock),
    target_american: americanFromProb(yTarget),
    quote_american: americanFromProb(yq),
    bid_american: yBid == null ? null : americanFromProb(yBid),
    perLeg: per.map((p) => ({
      true_american: americanFromProb(p.inverse),
      lock_american: p.lockCost == null ? null : americanFromProb(p.lockCost),
      mid_american: p.mid == null ? null : americanFromProb(p.mid),
      ref_american: p.reference == null ? null : americanFromProb(p.reference),
      opp_american: p.oppAmerican,
      lock_venue: p.lockVenue,
      p: p.inverse,
    })),
  };
}

// Would a taker's executed print (price y_trade, YES side) have gone to us?
function winsPrint(quoteYes, tradeYes) {
  if (!(quoteYes > 0) || !(tradeYes > 0)) return 'no';
  const d = r4(tradeYes - quoteYes);
  return d > 1e-9 ? 'win' : (Math.abs(d) <= 1e-9 ? 'tie' : 'no');
}

function fmtAm(a) {
  if (a == null || !Number.isFinite(Number(a))) return null;
  const n = Math.round(Number(a));
  return n > 0 ? `+${n}` : String(n);
}

// Estimated contracts the taker gets for a dollar RFQ at price y.
function contractsFor({ contracts, targetCostDollars }, quoteYes) {
  if (contracts > 0) return contracts;
  if (targetCostDollars > 0 && quoteYes > 0) return Math.floor((targetCostDollars / quoteYes) * 100) / 100;
  return 0;
}

module.exports = {
  priceLegFromQuotes,
  DEFAULTS, configFromEnv, isNoBoostShadow, isNoBoostLive,
  priceLeg, priceCombo, targetPrice, winsPrint, fmtAm, contractsFor,
  costWithFee, ceilTo, floorTo, tickFor, americanFromProb,
};
