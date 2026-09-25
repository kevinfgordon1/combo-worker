// Paper market-making prices. Pure functions.
//
// Inverse-bet guardrail: the most we will pay for team A (net of venue
// maker fee / rebate) is the complement of the best sportsbook price on
// team B. A two-sided pair must cost strictly less than $1 net of fees.
// Polymarket is preferred when nets tie, because of the maker rebate.
//
// No I/O. No orders.
'use strict';

const { POLY_MAKER_REBATE, POLY_TAKER_FEE } = require('./mm-paper-config');

const DEFAULT_CFG = Object.freeze({
  kalshiMakerCoeff: 0,
  polyMakerRebate: POLY_MAKER_REBATE,
  polyTakerFee: POLY_TAKER_FEE,
});

function cfgOf(cfg) {
  return cfg || DEFAULT_CFG;
}

function impliedProb(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 0) return 100 / (n + 100);
  return Math.abs(n) / (Math.abs(n) + 100);
}

function americanFromProb(p) {
  if (!(p > 0 && p < 1)) return null;
  if (p < 0.5) return Math.round((100 * (1 - p)) / p);
  return -Math.round((100 * p) / (1 - p));
}

function formatAmerican(american) {
  if (american == null || !Number.isFinite(Number(american)) || Number(american) === 0) return null;
  const n = Math.round(Number(american));
  return n > 0 ? `+${n}` : String(n);
}

function priceView(p) {
  if (p == null || !Number.isFinite(Number(p))) {
    return { price: null, cents: null, american: null, americanText: null };
  }
  const price = Math.round(Number(p) * 10000) / 10000;
  const american = americanFromProb(price);
  return { price, cents: Math.round(price * 100), american, americanText: formatAmerican(american) };
}

// Banker's rounding to the nearest cent (half to even). Polymarket US fees
// use this. 3.125 → 3.12, 17.375 → 17.38.
function bankersRoundCents(amount) {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const sign = amount < 0 ? -1 : 1;
  const scaled = Math.abs(amount) * 100;
  const base = Math.floor(scaled + 1e-8);
  const frac = scaled - base;
  let cents;
  if (frac > 0.5 + 1e-8) cents = base + 1;
  else if (frac < 0.5 - 1e-8) cents = base;
  else cents = (base % 2 === 0) ? base : base + 1;
  return (sign * cents) / 100;
}

function floorCent(p) {
  return Math.floor(Number(p) * 100 + 1e-9) / 100;
}

function roundCent(p) {
  return Math.round(Number(p) * 100) / 100;
}

function validPrice(p) {
  return p != null && p >= 0.01 && p <= 0.99;
}

// Signed fee dollars for `contracts` at `price`. Positive = we pay.
// Kalshi single-game maker is coeff * C * p * (1-p), default coeff 0.
// Polymarket US maker rebate is negative: -(rebate * C * p * (1-p)).
// Polymarket US taker fee is positive: taker * C * p * (1-p).
function exactFee(venue, price, contracts, cfg, role) {
  const c = cfgOf(cfg);
  const p = Number(price);
  const n = Number(contracts);
  if (!validPrice(p) || !(n > 0)) return null;
  const curve = n * p * (1 - p);
  if (venue === 'kalshi') {
    if (role === 'taker') return null;
    return c.kalshiMakerCoeff * curve;
  }
  if (venue === 'polymarket') {
    if (role === 'taker') return c.polyTakerFee * curve;
    return -(c.polyMakerRebate * curve);
  }
  return null;
}

function roundedFee(venue, price, contracts, cfg, role) {
  const exact = exactFee(venue, price, contracts, cfg, role);
  if (exact == null) return null;
  return bankersRoundCents(exact);
}

function totalNet(venue, price, contracts, cfg) {
  const fee = roundedFee(venue, price, contracts, cfg, 'maker');
  if (fee == null) return null;
  return Number(price) * Number(contracts) + fee;
}

function netPerContract(venue, price, contracts, cfg) {
  const n = Number(contracts);
  const total = totalNet(venue, price, n, cfg);
  if (total == null || !(n > 0)) return null;
  return Math.round((total / n) * 1e8) / 1e8;
}

function lockPriceFromOpponent(opponentProb) {
  const p = Number(opponentProb);
  if (!(p > 0 && p < 1)) return null;
  const lock = 1 - p;
  return lock > 0 && lock < 1 ? lock : null;
}

// Highest cent whose maker net is allowed by `accept(net)`.
function highestBid(venue, contracts, cfg, accept) {
  let best = null;
  for (let cent = 1; cent <= 99; cent += 1) {
    const price = cent / 100;
    const net = netPerContract(venue, price, contracts, cfg);
    if (net == null || !(net > 0) || !(net < 1)) continue;
    if (!accept(net, price)) continue;
    best = { price, net };
  }
  return best;
}

// Max bid that is still lockable vs the sportsbook inverse, and (when the
// other side already has a net) keeps the pair strictly under $1.
function capBid({ venue, contracts, lockPrice, otherNet, cfg }) {
  if (!validPrice(lockPrice) && lockPrice !== 0) {
    if (lockPrice == null) return null;
  }
  if (!(lockPrice > 0 && lockPrice < 1)) return null;
  return highestBid(venue, contracts, cfg, (net) => {
    if (net > lockPrice + 1e-9) return false;
    if (otherNet != null && !(net + otherNet < 1 - 1e-9)) return false;
    return true;
  });
}

function pairNetsOk(netA, netB) {
  return netA != null && netB != null && netA > 0 && netB > 0 && (netA + netB) < 1 - 1e-9;
}

function completePair(lotA, lotB) {
  if (!lotA || !lotB) return { ok: false, reason: 'missing_side' };
  if (!(lotA.qty > 0) || !(lotB.qty > 0)) return { ok: false, reason: 'empty' };
  if (!pairNetsOk(lotA.net, lotB.net)) {
    return { ok: false, reason: 'pair_crosses_dollar', combinedNet: (lotA.net || 0) + (lotB.net || 0) };
  }
  const qty = Math.min(lotA.qty, lotB.qty);
  const combinedNet = lotA.net + lotB.net;
  return {
    ok: true,
    qty,
    combinedNet,
    lockedProfit: qty * (1 - combinedNet),
  };
}

function preferVenue(offers) {
  const ok = (offers || []).filter((o) => o && validPrice(o.price) && o.net != null);
  if (!ok.length) return null;
  ok.sort((a, b) => {
    const diff = a.net - b.net;
    if (Math.abs(diff) > 1e-9) return diff;
    if (a.venue === 'polymarket' && b.venue !== 'polymarket') return -1;
    if (b.venue === 'polymarket' && a.venue !== 'polymarket') return 1;
    return 0;
  });
  return ok[0];
}

// Join the touch when it is at or under the cap. Never cross the ask.
// Never bid above the cap (the cap is already fee-adjusted).
function restingBid({ capPrice, bestBid, bestAsk }) {
  if (!validPrice(capPrice)) return null;
  const cap = floorCent(capPrice);
  if (!validPrice(cap)) return null;
  let px = cap;
  if (bestBid != null && bestBid >= 0.01 && bestBid <= cap + 1e-9) {
    px = Math.min(cap, floorCent(bestBid));
  }
  if (bestAsk != null && Number.isFinite(bestAsk)) {
    const underAsk = roundCent(bestAsk - 0.01);
    if (px >= bestAsk - 1e-9) px = underAsk;
  }
  if (!validPrice(px)) return null;
  if (bestAsk != null && px >= bestAsk - 1e-9) return null;
  return px;
}

// After a one-sided fill, walk the other bid toward the mid one step at a
// time. Never through the cap, never through the ask, never past the mid.
function stepTowardMid({ current, mid, stepCents, capPrice, bestAsk }) {
  if (!validPrice(current) || !(mid > current + 1e-9)) return current;
  const step = Number(stepCents) > 0 ? Number(stepCents) : 1;
  const stepped = Math.min(mid, current + step / 100);
  let px = floorCent(stepped);
  if (capPrice != null) px = Math.min(px, floorCent(capPrice));
  if (bestAsk != null && Number.isFinite(bestAsk)) {
    px = Math.min(px, roundCent(bestAsk - 0.01));
  }
  if (!validPrice(px) || px <= current + 1e-9) return current;
  if (bestAsk != null && px >= bestAsk - 1e-9) return current;
  return px;
}

// Shave the richer side until both maker nets sum to less than $1.
// On a tie, shave the non-Polymarket side so the rebate quote stays.
function enforcePair(sideA, sideB, cfg) {
  if (!sideA || !sideB || !validPrice(sideA.price) || !validPrice(sideB.price)) return null;
  const a = { venue: sideA.venue, price: roundCent(sideA.price), contracts: sideA.contracts };
  const b = { venue: sideB.venue, price: roundCent(sideB.price), contracts: sideB.contracts };
  for (let i = 0; i < 200; i += 1) {
    const na = netPerContract(a.venue, a.price, a.contracts, cfg);
    const nb = netPerContract(b.venue, b.price, b.contracts, cfg);
    if (pairNetsOk(na, nb)) return { a: { ...a, net: na }, b: { ...b, net: nb } };
    const shaveA = na > nb + 1e-12
      || (Math.abs(na - nb) <= 1e-12 && a.venue !== 'polymarket' && b.venue === 'polymarket')
      || (Math.abs(na - nb) <= 1e-12 && a.venue === b.venue && a.price >= b.price);
    const victim = shaveA ? a : b;
    const other = shaveA ? b : a;
    if (victim.price <= 0.01) {
      if (other.price <= 0.01) return null;
      other.price = roundCent(other.price - 0.01);
    } else {
      victim.price = roundCent(victim.price - 0.01);
    }
    if (!validPrice(a.price) || !validPrice(b.price)) return null;
  }
  return null;
}

function adverseMove(prev, next, cents) {
  if (prev == null || next == null) return next == null && prev != null;
  const thresh = (Number(cents) || 0) / 100;
  return (prev - next) >= thresh - 1e-9;
}

// Conservative queue. At our price, size already resting is filled first.
// A trade strictly through our bid clears that queue, then fills us only
// up to the printed size. Unknown queue (null) never fills at our price.
function simulateFill(quote, trade) {
  if (!quote || !trade) return null;
  if (!(trade.qty > 0) || !(quote.size > 0)) return null;
  if (!(Number(trade.price) <= Number(quote.price) + 1e-9)) return null;
  const at = Math.abs(Number(trade.price) - Number(quote.price)) <= 0.0005 + 1e-9;
  let queue = quote.queueAhead;
  let qty = Number(trade.qty);
  if (at) {
    if (queue == null) {
      return { fillQty: 0, queueAhead: null, sizeLeft: quote.size, reason: 'queue_unknown' };
    }
    const eat = Math.min(queue, qty);
    queue -= eat;
    qty -= eat;
  } else {
    queue = 0;
  }
  const fillQty = Math.min(quote.size, Math.max(0, qty));
  return {
    fillQty,
    queueAhead: queue,
    sizeLeft: quote.size - fillQty,
    reason: fillQty > 0 ? (at ? 'at' : 'through') : 'queued',
  };
}

module.exports = {
  DEFAULT_CFG,
  impliedProb,
  americanFromProb,
  formatAmerican,
  priceView,
  bankersRoundCents,
  floorCent,
  roundCent,
  exactFee,
  roundedFee,
  totalNet,
  netPerContract,
  lockPriceFromOpponent,
  capBid,
  pairNetsOk,
  completePair,
  preferVenue,
  restingBid,
  stepTowardMid,
  enforcePair,
  adverseMove,
  simulateFill,
};
