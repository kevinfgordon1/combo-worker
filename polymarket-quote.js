// Polymarket US institutional RFQ quote math (slice 1).
// Combo Locks sells the parlay: offer buyPrice only, decline sellPrice with "0".
//
// Live stream/auth/symbol-mapping come later. Do not POST from this module.
// evaluatePolymarketRfq passes estimatedContracts into decideAtFill as
// rfqContracts with allowPartial so leftover remaining can size a smaller
// qtyDecimal quote. This file does not call decideAtFill or change Kalshi
// yes_bid / implied-YES dollar RFQ behavior.
'use strict';
const { impliedProb } = require('./engine');

const TICK = 0.001;
const SELL_PRICE_DECLINE = '0';
const MIN_TICKS = 1;     // 0.001
const MAX_TICKS = 999;   // 0.999

// Polymarket US combos carry NO maker rebate (docs.polymarket.us/fees, effective 2026-10-07; exchange
// notice "Maker Rebate on Combination Contracts" 2026-10-02: "the maker fee for combos will be zero").
// The old 0.0125 straight-market rebate was credited here and made POLY_EXACT_TARGET quotes net
// below the lock target. Default 0; POLY_MAKER_REBATE_THETA can re-enable if Polymarket restores it.
const DEFAULT_REBATE_THETA = 0;
// Only credit the rebate on fills this large: the per-fill cent rounding is noise there.
const DEFAULT_REBATE_MIN_CONTRACTS = 40;
// Per-fill cent rounding can shave up to half a cent off the rebate; never count on it.
const REBATE_ROUNDING_MARGIN = 0.005;
// Cash RFQs: the venue's real size came in 7-11% under cash/price (it also reserves taker fee), so size the
// rebate credit off a deliberately low contract estimate.
const CASH_QTY_CREDIT_FACTOR = 0.85;

// POLY_EXACT_TARGET: price at the exact lock target (ceil to the 0.001 tick, minus the maker rebate on big
// fills) instead of flooring to the tick. Default ON; 0/false/off/no restores the old floor.
function polyExactTargetEnabled(env = process.env) {
  const raw = env && env.POLY_EXACT_TARGET;
  if (raw == null || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

// POLY_FINE_TICK (default ON): price on the RFQ's own tickSize (combos are 0.0001) instead of the
// hard-coded 0.001. 0/false/off/no restores the 0.001 grid. Only ticks in [0.0001, 0.01] on the
// 0.0001 lattice are trusted; anything missing or odd falls back to 0.001.
const FINEST_TICK = 0.0001;
function polyFineTickEnabled(env = process.env) {
  const raw = env && env.POLY_FINE_TICK;
  if (raw == null || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}
function resolveTick(tickSize, env = process.env) {
  if (!polyFineTickEnabled(env)) return TICK;
  const t = Number(tickSize);
  if (!Number.isFinite(t) || t < FINEST_TICK - 1e-12 || t > 0.01 + 1e-12) return TICK;
  const units = Math.round(t / FINEST_TICK);
  if (Math.abs(units * FINEST_TICK - t) > 1e-12) return TICK;
  return units * FINEST_TICK;
}
function tickDecimals(tick) {
  return tick < 0.001 - 1e-12 ? 4 : 3;
}

function envNum(env, key, dflt) {
  const raw = env && env[key];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function parseAmerican(a) {
  if (a == null || a === '') return null;
  const n = typeof a === 'string' ? parseFloat(a) : Number(a);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function parsePositive(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Floor to the 0.001 tick — never round buyPrice UP past the fill.
// Selling YES cheaper than the fill would mean rounding the implied prob up
// (shorter American). Floor so +350 → 0.2222… stays "0.222", not "0.223".
function floorToTick(p) {
  return Math.floor(p / TICK + 1e-9) * TICK;
}

function fillAmericanToBuyPrice(fillAmerican) {
  const a = parseAmerican(fillAmerican);
  if (a == null) return null;
  const p = impliedProb(a);
  if (!(p > 0 && p < 1)) return null;
  const floored = floorToTick(p);
  if (!(floored > 0)) return null;
  return floored.toFixed(3);
}

// Guaranteed rebate per contract at `price` for a fill of at least `qty` contracts (0 when qty is too small to
// trust). Lower bound only: exact rebate minus the worst-case cent rounding, spread over the fill.
function rebateCreditPerContract(price, qty, { theta = DEFAULT_REBATE_THETA, minContracts = DEFAULT_REBATE_MIN_CONTRACTS } = {}) {
  const p = Number(price);
  const q = Number(qty);
  if (!(p > 0 && p < 1) || !(q >= minContracts) || !(q > 0) || !(theta > 0)) return 0;
  const credit = theta * p * (1 - p) - REBATE_ROUNDING_MARGIN / q;
  return credit > 0 ? credit : 0;
}

// Exact-target price: the lowest tick whose price + guaranteed rebate is still >= the lock target (the most
// competitive quote that never nets worse than the target). With no creditable rebate this is ceil(target).
// Returns { buyPrice, credit, target } or null (no valid tick).
function fillAmericanToExactQuote(fillAmerican, { contracts = 0, env = process.env, theta, minContracts, tickSize } = {}) {
  const a = parseAmerican(fillAmerican);
  if (a == null) return null;
  const target = impliedProb(a);
  if (!(target > 0 && target < 1)) return null;
  const th = theta != null ? theta : envNum(env, 'POLY_MAKER_REBATE_THETA', DEFAULT_REBATE_THETA);
  const minC = minContracts != null ? minContracts : envNum(env, 'POLY_REBATE_MIN_CONTRACTS', DEFAULT_REBATE_MIN_CONTRACTS);
  // The rebate can never exceed theta/4 per contract, so no tick below target - theta/4 can qualify.
  // Work in integer ticks so 0.0001 grids never drift. Same rule on any tick: the lowest tick whose
  // price (+ creditable rebate) is >= target, i.e. the closest price that never beats the lock.
  const tick = resolveTick(tickSize, env);
  const perUnit = Math.round(1 / tick);
  const dp = tickDecimals(tick);
  const minK = Math.round(MIN_TICKS * TICK / tick);
  const maxK = perUnit - minK;
  let k = Math.max(minK, Math.ceil((target - th / 4 - 1e-6) * perUnit - 1e-9));
  for (; k <= maxK; k++) {
    const price = k / perUnit;
    const credit = rebateCreditPerContract(price, contracts, { theta: th, minContracts: minC });
    if (price + credit + 1e-12 >= target) {
      return { buyPrice: price.toFixed(dp), credit, target, tick };
    }
  }
  return null;
}

// qtyDecimal RFQ: that quantity on the offered (buy) side.
// cashOrderQty RFQ: floor(cash / buyPrice) — venue derives this server-side too.
function buildPolymarketQuote({ fillAmerican, cashOrderQty, qtyDecimal, exact, env, tickSize } = {}) {
  const useExact = exact != null ? !!exact : polyExactTargetEnabled(env || process.env);
  const qty = parsePositive(qtyDecimal);
  const cash = parsePositive(cashOrderQty);
  let buyPrice;
  let rebateCredit = 0;
  let estimatedContracts = 0;
  if (!useExact) {
    buyPrice = fillAmericanToBuyPrice(fillAmerican);
    if (buyPrice == null) return null;
    if (qty != null) estimatedContracts = qty;
    else if (cash != null) estimatedContracts = Math.floor(cash / parseFloat(buyPrice));
  } else {
    // Contracts decide whether the rebate may be credited, and for a cash RFQ the contracts depend on the
    // price: size it off the no-rebate price (highest, so fewest contracts), then haircut it.
    const base = fillAmericanToExactQuote(fillAmerican, { contracts: 0, env, tickSize });
    if (!base) return null;
    const creditQty = qty != null
      ? qty
      : (cash != null ? Math.floor((cash / parseFloat(base.buyPrice)) * CASH_QTY_CREDIT_FACTOR) : 0);
    const q = fillAmericanToExactQuote(fillAmerican, { contracts: creditQty, env, tickSize });
    if (!q) return null;
    buyPrice = q.buyPrice;
    rebateCredit = q.credit;
    if (qty != null) estimatedContracts = qty;
    else if (cash != null) estimatedContracts = Math.floor(cash / parseFloat(buyPrice));
  }
  return {
    buyPrice,
    sellPrice: SELL_PRICE_DECLINE,
    estimatedContracts,
    rebateCredit,
    exact: useExact,
  };
}

// Last look ~3s. Confirm only when the requester bought (we sold the combo YES).
// SIDE_SELL would buy the parlay — decline / do not confirm.
function shouldConfirmPolymarketAccept(acceptedSide) {
  const raw = String(acceptedSide || '').trim().toLowerCase();
  if (!raw) return false;
  const side = raw.replace(/^side_/, '');
  return side === 'buy';
}

function shouldPostPolymarketQuote(size) {
  if (!size || typeof size !== 'object') return false;
  const n = Number(size.estimatedContracts);
  return Number.isFinite(n) && n > 0;
}

module.exports = {
  TICK,
  DEFAULT_REBATE_THETA,
  DEFAULT_REBATE_MIN_CONTRACTS,
  CASH_QTY_CREDIT_FACTOR,
  polyExactTargetEnabled,
  polyFineTickEnabled,
  resolveTick,
  rebateCreditPerContract,
  fillAmericanToExactQuote,
  SELL_PRICE_DECLINE,
  fillAmericanToBuyPrice,
  buildPolymarketQuote,
  shouldConfirmPolymarketAccept,
  shouldPostPolymarketQuote,
};
