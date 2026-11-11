// Polymarket US combo (parlay) maker fee.
// docs.polymarket.us/fees → Combo Trading → Maker Fees.
//
//   Fee = 0.03 × C × p × (1 − p)
//
// Effective Saturday Nov 14, 2026 12:00 AM America/New_York, which is
// 2026-11-14T05:00:00Z (EST, UTC−5; DST ended Nov 1). Fills before that
// instant pay $0. Single-market maker fees are not this schedule and stay $0.
// Combo fills still carry no maker rebate.
//
// The fee schedule rounds every fee to the nearest cent with banker's
// rounding (half to even). Example: 100 contracts at $0.10 = $0.27.
// A small fill can round down to $0.00.
'use strict';

const { isPolyComboTicker } = require('./series-fee');

const POLY_COMBO_MAKER_RATE = 0.03;
// Inclusive: a fill at this instant pays the fee.
const POLY_COMBO_MAKER_FEE_EFFECTIVE_AT = Date.parse('2026-11-14T05:00:00Z');

function atMs(at) {
  if (at == null || at === '') return Date.now();
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  const t = Date.parse(String(at));
  return Number.isFinite(t) ? t : NaN;
}

// Unknown clock → charge the fee. Never quote as if it were still free.
function polyComboMakerRate(at) {
  const t = atMs(at);
  if (!Number.isFinite(t)) return POLY_COMBO_MAKER_RATE;
  return t >= POLY_COMBO_MAKER_FEE_EFFECTIVE_AT ? POLY_COMBO_MAKER_RATE : 0;
}

// Nearest cent, half to even. Same rule as the combo taker fee.
function roundHalfEvenCents(x) {
  const c = x * 100;
  const f = Math.floor(c);
  const d = c - f;
  if (Math.abs(d - 0.5) < 1e-9) return (f % 2 === 0 ? f : f + 1) / 100;
  return Math.round(c) / 100;
}

function polyComboMakerFeeDollars(contracts, price, at) {
  const rate = polyComboMakerRate(at);
  if (!(rate > 0)) return 0;
  const C = Number(contracts);
  const p = Number(price);
  if (!(C > 0) || !(p > 0 && p < 1)) return 0;
  return roundHalfEvenCents(rate * C * p * (1 - p));
}

// Per-contract drag used when pricing a quote. Known size uses the cent-rounded
// order fee (so a 1-lot that rounds to $0 is not marked up). Unknown size uses
// the continuous 0.03·p·(1−p), which never understates a large fill.
function polyComboMakerFeePerContract(price, contracts, at) {
  const p = Number(price);
  const rate = polyComboMakerRate(at);
  if (!(rate > 0) || !(p > 0 && p < 1)) return 0;
  const C = Number(contracts);
  if (C > 0) {
    const fee = polyComboMakerFeeDollars(C, p, at);
    return fee > 0 ? fee / C : 0;
  }
  return rate * p * (1 - p);
}

// Gross YES price whose continuous maker fee still nets `net` per contract.
// p − rate·p·(1−p) = net. rate 0 → p = net.
function polyComboPriceForNet(net, rate) {
  const s = Number(net);
  const k = Number(rate);
  if (!(s > 0 && s < 1)) return null;
  if (!(k > 0)) return s;
  const b = 1 - k;
  const disc = b * b + 4 * k * s;
  if (!(disc >= 0)) return null;
  const p = (-b + Math.sqrt(disc)) / (2 * k);
  return p > 0 && p < 1 ? p : null;
}

// Dollar fee for a recorded maker fill.
// A non-combo slug (single market) stays $0. Missing slug charges only when
// the caller knows the path is a combo RFQ (assumeCombo).
function polyComboMakerFeeForFill({ contracts, price, at, market, assumeCombo = false } = {}) {
  const slug = String(market || '').trim();
  if (slug) {
    if (!isPolyComboTicker(slug)) return 0;
  } else if (!assumeCombo) {
    return 0;
  }
  return polyComboMakerFeeDollars(contracts, price, at);
}

module.exports = {
  POLY_COMBO_MAKER_RATE,
  POLY_COMBO_MAKER_FEE_EFFECTIVE_AT,
  polyComboMakerRate,
  polyComboMakerFeeDollars,
  polyComboMakerFeePerContract,
  polyComboPriceForNet,
  polyComboMakerFeeForFill,
  roundHalfEvenCents,
};
