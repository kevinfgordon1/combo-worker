// Polymarket US institutional RFQ quote math (slice 1).
// Combo Locks sells the parlay: offer buyPrice only, decline sellPrice with "0".
//
// Live stream/auth/symbol-mapping come later. Do not POST from this module.
// Live-runner will pass estimatedContracts into decideAtFill as rfqContracts so
// Kalshi and Polymarket share the same remaining cap. This file does not call
// decideAtFill or change Kalshi yes_bid / implied-YES dollar RFQ behavior.
'use strict';
const { impliedProb } = require('./engine');

const TICK = 0.001;
const SELL_PRICE_DECLINE = '0';

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

// qtyDecimal RFQ: that quantity on the offered (buy) side.
// cashOrderQty RFQ: floor(cash / buyPrice) — venue derives this server-side too.
function buildPolymarketQuote({ fillAmerican, cashOrderQty, qtyDecimal } = {}) {
  const buyPrice = fillAmericanToBuyPrice(fillAmerican);
  if (buyPrice == null) return null;
  const qty = parsePositive(qtyDecimal);
  const cash = parsePositive(cashOrderQty);
  let estimatedContracts = 0;
  if (qty != null) {
    estimatedContracts = qty;
  } else if (cash != null) {
    estimatedContracts = Math.floor(cash / parseFloat(buyPrice));
  }
  return {
    buyPrice,
    sellPrice: SELL_PRICE_DECLINE,
    estimatedContracts,
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
  SELL_PRICE_DECLINE,
  fillAmericanToBuyPrice,
  buildPolymarketQuote,
  shouldConfirmPolymarketAccept,
  shouldPostPolymarketQuote,
};
