// Novig RFQ price. The lock's fill_american is the parlay's win odds (the
// same number Combo Locks stores). Maker fee on an RFQ parlay is $0, so the
// win probability is that American price with no fee gross-up.
//
// RFQ V3 takes any 0.001 price from 0.001 to 0.999. The docs only reject a
// price outside that range. The order book is coarser (0.005 steps from
// 0.055 to 0.945, and 0.051–0.054 are not book prices), and live RFQ
// executions print off that book grid, including 0.051–0.054. This file
// quotes RFQs only. It does not build book orders.
//
// The lowest win probability wins, so we snap UP to the next 0.001 and never
// down. +350 is 0.22222… and quotes 0.223 (about +348). +400 is 0.200 and
// stays. A higher price pays the user less and never beats the lock.
'use strict';

const { makerRateForVenue } = require('./series-fee');

const PRICE_MIN_MILLI = 1;
const PRICE_MAX_MILLI = 999;
const CONFIRM_RATE_FLOOR = 0.995;

function onGrid(milli) {
  return Number.isInteger(milli) && milli >= PRICE_MIN_MILLI && milli <= PRICE_MAX_MILLI;
}

// Ceil onto a thousandth. The 1e-9 slack matches milliFromAmerican so a value
// that is already an exact milli does not bump because of binary noise.
// Anything that would land above 0.999 is refused (we do not snap down).
function snapUpMilli(milli) {
  if (milli == null || !Number.isFinite(Number(milli))) return null;
  const m = Math.ceil(Number(milli) - 1e-9);
  if (m > PRICE_MAX_MILLI) return null;
  if (m < PRICE_MIN_MILLI) return PRICE_MIN_MILLI;
  return m;
}

// Positive American: p = 100 / (a + 100). Negative: p = |a| / (|a| + 100).
// Returned in thousandths, rounded UP so a binary float cannot snap down.
function milliFromAmerican(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return null;
  if (Number.isInteger(n)) {
    if (n > 0) return Math.floor((100000 + n + 100 - 1) / (n + 100));
    const abs = Math.abs(n);
    return Math.floor((abs * 1000 + abs + 100 - 1) / (abs + 100));
  }
  const p = n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
  if (!(p > 0) || p >= 1) return null;
  return Math.ceil(p * 1000 - 1e-9);
}

function milliFromDecimal(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const head = (frac + '000').slice(0, 3);
  const extra = frac.length > 3 ? Number(frac[3]) : 0;
  let milli = Number(whole) * 1000 + Number(head);
  if (extra >= 5) milli += 1;
  if (!Number.isFinite(milli)) return null;
  return milli;
}

function priceFromMilli(milli) {
  if (milli == null) return null;
  return (milli / 1000).toFixed(3);
}

// Win probability we would send, as a 3-place decimal string, or null.
function quotePriceFromAmerican(american) {
  if (makerRateForVenue('novig') !== 0) return null;
  const raw = milliFromAmerican(american);
  if (raw == null) return null;
  const milli = snapUpMilli(raw);
  if (milli == null || !onGrid(milli)) return null;
  return priceFromMilli(milli);
}

function americanFromMilli(milli) {
  if (!(milli > 0) || milli >= 1000) return null;
  const p = milli / 1000;
  if (p >= 0.5) return Math.round(-100 * p / (1 - p));
  return Math.round(100 * (1 - p) / p);
}

function formatAmerican(n) {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) === 0) return '';
  const a = Math.round(Number(n));
  return a > 0 ? `+${a}` : String(a);
}

// Collateral the maker posts against a user stake: stake * (1 - p) / p.
function collateralForWager(wager, priceMilli) {
  const w = Number(wager);
  if (!(w > 0) || !(priceMilli > 0) || priceMilli >= 1000) return null;
  return w * (1000 - priceMilli) / priceMilli;
}

// User stake a payout of `contracts` ($1 each) supports at this price.
function wagerForContracts(contracts, priceMilli) {
  const c = Number(contracts);
  if (!(c > 0) || !(priceMilli > 0) || priceMilli >= 1000) return 0;
  return c * priceMilli / 1000;
}

// Largest user stake whose collateral fits in `dollars`.
function wagerForCollateral(dollars, priceMilli) {
  const d = Number(dollars);
  if (!(d > 0) || !(priceMilli > 0) || priceMilli >= 1000) return 0;
  return d * priceMilli / (1000 - priceMilli);
}

function floorCents(n) {
  if (!(n > 0) || !Number.isFinite(n)) return 0;
  return Math.floor(n * 100 + 1e-6) / 100;
}

function moneyString(dollars) {
  const cents = Math.round(Number(dollars) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const d = Math.floor(cents / 100);
  const r = cents % 100;
  if (r === 0) return String(d);
  if (r % 10 === 0) return `${d}.${r / 10}`;
  return `${d}.${String(r).padStart(2, '0')}`;
}

function decimalToNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// maxWager is the user stake. Caps are in collateral dollars except the hard
// wager cap and the lock's remaining payout (contracts × price).
function maxWagerFor({
  priceMilli,
  remainingContracts,
  freeBalance,
  perQuoteCollateral,
  perLockCollateral,
  totalCollateral,
  hardWagerCap,
} = {}) {
  if (!(priceMilli > 0) || priceMilli >= 1000) return { wager: 0, reason: 'bad_price' };
  const limits = [];
  if (remainingContracts != null) limits.push(wagerForContracts(remainingContracts, priceMilli));
  if (freeBalance != null) limits.push(wagerForCollateral(freeBalance, priceMilli));
  if (perQuoteCollateral != null) limits.push(wagerForCollateral(perQuoteCollateral, priceMilli));
  if (perLockCollateral != null) limits.push(wagerForCollateral(perLockCollateral, priceMilli));
  if (totalCollateral != null) limits.push(wagerForCollateral(totalCollateral, priceMilli));
  if (hardWagerCap != null) limits.push(Number(hardWagerCap));
  if (!limits.length) return { wager: 0, reason: 'no_cap' };
  const raw = Math.min(...limits.filter((n) => Number.isFinite(n)));
  const wager = floorCents(raw);
  return { wager: wager > 0 ? wager : 0, raw };
}

// Payout contracts the quote can fill, rounded UP so the hold covers maxWager.
function payoutContracts(wager, priceMilli) {
  const w = Number(wager);
  if (!(w > 0) || !(priceMilli > 0)) return 0;
  const cents = Math.ceil((w * 1000 * 100) / priceMilli - 1e-6);
  return cents / 100;
}

function readPositive(env, name, fallback) {
  const n = Number(env && env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readCaps(env = process.env) {
  return {
    hardWagerCap: readPositive(env, 'NOVIG_MAX_WAGER_USD', 25),
    perQuoteCollateral: readPositive(env, 'NOVIG_MAX_COLLATERAL_PER_QUOTE', 100),
    perLockCollateral: readPositive(env, 'NOVIG_MAX_COLLATERAL_PER_LOCK', 250),
    totalCollateral: readPositive(env, 'NOVIG_MAX_COLLATERAL_TOTAL', 500),
    confirmRateFloor: readPositive(env, 'NOVIG_CONFIRM_RATE_FLOOR', CONFIRM_RATE_FLOOR),
    confirmMinSample: Math.max(1, Math.floor(readPositive(env, 'NOVIG_CONFIRM_MIN_SAMPLE', 1))),
  };
}

module.exports = {
  PRICE_MIN_MILLI,
  PRICE_MAX_MILLI,
  CONFIRM_RATE_FLOOR,
  onGrid,
  snapUpMilli,
  milliFromAmerican,
  milliFromDecimal,
  priceFromMilli,
  quotePriceFromAmerican,
  americanFromMilli,
  formatAmerican,
  collateralForWager,
  wagerForContracts,
  wagerForCollateral,
  floorCents,
  moneyString,
  decimalToNumber,
  maxWagerFor,
  payoutContracts,
  readCaps,
};
