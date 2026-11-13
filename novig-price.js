// Novig RFQ price. The lock's fill_american is the parlay's win odds (the
// same number Combo Locks stores). Maker fee on an RFQ parlay is $0, so the
// win probability is that American price with no fee gross-up.
//
// Novig's order-book grid snaps DOWN because every order buys. An RFQ quote
// is the opposite: the lowest win probability wins, so we snap UP. A higher
// price pays the user less and never beats the lock.
//
// Grid (docs: Monetary representations), in thousandths:
//   1..50 and 950..999 step 1; 55..945 step 5.
//   51..54 round up to 55; 946..949 round up to 950.
'use strict';

const { makerRateForVenue } = require('./series-fee');

const PRICE_MIN_MILLI = 1;
const PRICE_MAX_MILLI = 999;
const CONFIRM_RATE_FLOOR = 0.995;

function onGrid(milli) {
  if (milli >= 1 && milli <= 50) return true;
  if (milli >= 55 && milli <= 945 && milli % 5 === 0) return true;
  if (milli >= 950 && milli <= 999) return true;
  return false;
}

function snapUpMilli(milli) {
  const m = Math.round(milli);
  if (m > PRICE_MAX_MILLI) return null;
  if (m < PRICE_MIN_MILLI) return PRICE_MIN_MILLI;
  if (m <= 50) return m;
  if (m < 55) return 55;
  if (m <= 945) {
    const rem = m % 5;
    return rem === 0 ? m : m + (5 - rem);
  }
  if (m < 950) return 950;
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
