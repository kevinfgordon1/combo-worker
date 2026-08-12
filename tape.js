// Conservative public-tape match for a lost RFQ. Pure helpers — no I/O, places nothing.
'use strict';
const { americanFromProb } = require('./engine');

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Prefer *_dollars; integer yes_price/no_price is cents (same as fills-reader).
function toPriceDollars(dollarsField, centsOrDollarField) {
  const d = toNum(dollarsField);
  if (d != null) return d;
  const n = toNum(centsOrDollarField);
  if (n == null) return null;
  if (n > 1 && n <= 100) return n / 100;
  return n;
}

function tradeCount(t) {
  if (!t) return null;
  return toNum(t.count_fp != null ? t.count_fp : t.count);
}

function countExact(a, b) {
  return a > 0 && b > 0 && Math.abs(a - b) <= 0.01;
}

function countClose(a, b) {
  if (!(a > 0) || !(b > 0)) return false;
  const abs = Math.abs(a - b);
  return abs <= 0.01 || abs / b <= 0.01;
}

function formatAmerican(a) {
  if (a == null || !Number.isFinite(a)) return null;
  return a > 0 ? '+' + a : String(a);
}

function priceKey(yes, no) {
  const y = yes != null ? Math.round(yes * 10000) / 10000 : null;
  const n = no != null ? Math.round(no * 10000) / 10000 : null;
  return `${y}|${n}`;
}

function normalizeTrade(t, parseTs) {
  const count = tradeCount(t);
  let yes = t ? toPriceDollars(t.yes_price_dollars ?? t.yes_price_fixed, t.yes_price) : null;
  let no = t ? toPriceDollars(t.no_price_dollars ?? t.no_price_fixed, t.no_price) : null;
  if (yes == null && no != null) yes = Math.round((1 - no) * 100) / 100;
  if (no == null && yes != null) no = Math.round((1 - yes) * 100) / 100;
  const ts = parseTs ? parseTs(t && (t.created_time || t.ts || t.created_ts)) : null;
  return { count, yes, no, ts, raw: t };
}

// Only alert on a unique size+time print. 2+ different prices at the same count → ambiguous.
function matchTapeTrades(normalizedTrades, { rfqCount, closedMs } = {}) {
  const trades = (normalizedTrades || []).filter((t) => t && t.count > 0 && (t.yes != null || t.no != null));
  if (!trades.length) return { match: 'none' };

  let pool;
  if (rfqCount > 0) {
    const sizeHits = trades.filter((t) => countClose(t.count, rfqCount));
    if (!sizeHits.length) return { match: 'none' };
    const exact = sizeHits.filter((t) => countExact(t.count, rfqCount));
    pool = exact.length ? exact : sizeHits;
  } else {
    pool = trades;
  }

  const keys = new Set(pool.map((t) => priceKey(t.yes, t.no)));
  if (keys.size > 1) return { match: 'ambiguous' };

  let best = pool[0];
  if (closedMs != null && pool.length > 1) {
    let bestAbs = Infinity;
    for (const t of pool) {
      const dt = t.ts != null ? Math.abs(t.ts - closedMs) : Infinity;
      if (dt < bestAbs) { bestAbs = dt; best = t; }
    }
  }
  return {
    match: 'matched',
    trade: best,
    yesPrice: best.yes,
    noPrice: best.no,
    count: best.count,
    tradeTs: best.ts,
  };
}

function fmtCount(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : String(n);
}

function formatLostAlert({ label, rfqId, lossReason, tape, ourNo }) {
  const reason = lossReason || 'lost';
  let text = `📉 LOST (${reason}) — ${label || '(unknown)'}\nRFQ ${rfqId || '?'}`;
  if (tape && tape.match === 'matched' && tape.noPrice != null) {
    const yesAm = formatAmerican(americanFromProb(tape.yesPrice));
    const yesBit = yesAm ? ` (~YES ${yesAm})` : '';
    const cnt = tape.count != null ? ` · ${fmtCount(tape.count)} contracts` : '';
    text += `\nTape: NO @ $${Number(tape.noPrice).toFixed(2)}${yesBit}${cnt}`;
  } else if (reason === 'outbid') {
    text += '\nNo clean tape match';
  }
  if (ourNo != null && Number.isFinite(Number(ourNo))) {
    text += `\nOur quote was NO @ $${Number(ourNo).toFixed(2)}`;
  }
  return text;
}

module.exports = {
  toNum,
  toPriceDollars,
  tradeCount,
  countClose,
  americanFromProb,
  formatAmerican,
  normalizeTrade,
  matchTapeTrades,
  formatLostAlert,
  fmtCount,
};
