// Conservative public-tape match for a lost RFQ. Pure helpers — no I/O, places nothing.
'use strict';
const { americanFromProb } = require('./engine');
const { shortId } = require('./short-id');

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
  // Kalshi $ RFQs often print fractional counts (e.g. RFQ 9 → tape 9.31).
  return abs <= 1 || abs / b <= 0.05;
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

function blockFlag(t) {
  if (!t) return null;
  if (typeof t.isBlockTrade === 'boolean') return t.isBlockTrade;
  if (typeof t.is_block_trade === 'boolean') return t.is_block_trade;
  return null;
}

function normalizeTrade(t, parseTs) {
  const count = tradeCount(t);
  let yes = t ? toPriceDollars(t.yes_price_dollars ?? t.yes_price_fixed, t.yes_price) : null;
  let no = t ? toPriceDollars(t.no_price_dollars ?? t.no_price_fixed, t.no_price) : null;
  if (yes == null && no != null) yes = Math.round((1 - no) * 100) / 100;
  if (no == null && yes != null) no = Math.round((1 - yes) * 100) / 100;
  const ts = parseTs ? parseTs(t && (t.created_time || t.ts || t.created_ts)) : null;
  return { count, yes, no, ts, isBlockTrade: blockFlag(t), raw: t };
}

// RFQ fills show up as is_block_trade=true. Prefer those so ordinary book prints
// cannot steal the match. Still require unique size+time; 2+ block prices → ambiguous.
function matchTapeTrades(normalizedTrades, { rfqCount, closedMs } = {}) {
  const trades = (normalizedTrades || []).filter((t) => t && t.count > 0 && (t.yes != null || t.no != null));
  if (!trades.length) return { match: 'none' };

  const flagged = trades.some((t) => t.isBlockTrade === true || t.isBlockTrade === false);
  let candidates = flagged ? trades.filter((t) => t.isBlockTrade === true) : trades;
  // Kalshi sometimes prints RFQ fills with is_block_trade=false (seen on $1 combo).
  // Prefer block prints when present; otherwise fall back to the full tape.
  if (!candidates.length) candidates = trades;
  if (!candidates.length) return { match: 'none' };

  let pool;
  if (rfqCount > 0) {
    const sizeHits = candidates.filter((t) => countClose(t.count, rfqCount));
    if (!sizeHits.length) return { match: 'none' };
    const exact = sizeHits.filter((t) => countExact(t.count, rfqCount));
    pool = exact.length ? exact : sizeHits;
  } else {
    pool = candidates;
  }

  const keys = new Set(pool.map((t) => priceKey(t.yes, t.no)));
  if (keys.size > 1) return { match: 'ambiguous' };

  // Same-price size pool: closest to closedMs when known, else latest print.
  // Proximity ties (and open RFQs with closedMs null) take the latest ts —
  // do not keep pool[0] (often the first/earliest block from RFQ create).
  let best = pool[0];
  if (pool.length > 1) {
    let bestAbs = closedMs != null
      ? (best.ts != null ? Math.abs(best.ts - closedMs) : Infinity)
      : 0;
    let bestTs = best.ts != null ? best.ts : -Infinity;
    for (const t of pool) {
      const dt = closedMs != null
        ? (t.ts != null ? Math.abs(t.ts - closedMs) : Infinity)
        : 0;
      const ts = t.ts != null ? t.ts : -Infinity;
      if (dt < bestAbs || (dt === bestAbs && ts > bestTs)) {
        best = t;
        bestAbs = dt;
        bestTs = ts;
      }
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

function impliedYes(noPrice) {
  const n = toNum(noPrice);
  if (n == null) return null;
  return Math.round((1 - n) * 100) / 100;
}

function yesAmericanBit(yesPrice) {
  const yesAm = formatAmerican(americanFromProb(yesPrice));
  return yesAm ? ` (~YES ${yesAm})` : '';
}

// theirNo − ourNo. Positive = they paid more for NO (we were too cheap on NO).
function outbidDelta(ourNo, theirNo) {
  const ours = toNum(ourNo);
  const theirs = toNum(theirNo);
  if (ours == null || theirs == null) return null;
  return Math.round((theirs - ours) * 100) / 100;
}

function fmtNo(price) {
  const n = toNum(price);
  return n == null ? null : `$${n.toFixed(2)}`;
}

function fillBit(fillAmerican) {
  const a = toNum(fillAmerican);
  if (a == null) return '';
  const s = formatAmerican(a);
  return s ? ` · ${s}` : '';
}

// Recent classified loss → one Telegram. Tape-matched outbid, nobody bought
// (no_purchase / cancelled no_taker), or we missed the window (too_slow).
function shouldAlertLost({ recent, lossReason, tapeMatch } = {}) {
  if (!recent) return false;
  if (tapeMatch === 'matched') return true;
  return lossReason === 'no_purchase' || lossReason === 'no_taker'
    || lossReason === 'too_slow' || lossReason === 'outbid';
}

function formatLostAlert({ label, rfqId, lossReason, tape, ourNo, fillAmerican }) {
  const reason = lossReason || 'lost';
  const name = label || '(unknown)';
  const rfq = shortId(rfqId);
  const our = fmtNo(ourNo);
  const ourLine = our ? `Our NO @ ${our}${fillBit(fillAmerican)}` : null;
  const tapeClean = !!(tape && tape.match === 'matched' && (tape.noPrice != null || tape.yesPrice != null));

  if ((reason === 'no_purchase' || reason === 'no_taker') && !tapeClean) {
    let text = `📉 NO PURCHASE — ${name}\nRFQ ${rfq}`;
    if (ourLine) text += `\n${ourLine}`;
    return text;
  }

  if (reason === 'too_slow' && !tapeClean) {
    let text = `📉 TOO SLOW — ${name}\nRFQ ${rfq} · missed the window`;
    if (ourLine) text += `\n${ourLine}`;
    return text;
  }

  if (tapeClean) {
    const theirNo = toNum(tape.noPrice);
    const tapeYes = tape.yesPrice != null ? toNum(tape.yesPrice) : impliedYes(theirNo);
    const ourYes = impliedYes(ourNo);
    const cnt = tape.count != null ? ` · ${fmtCount(tape.count)} contracts` : '';
    let text = `📉 LOST (outbid) — ${name}\nRFQ ${rfq}`;
    if (our) text += `\nOur NO @ ${our}${yesAmericanBit(ourYes)}`;
    if (theirNo != null) text += `\nTape NO @ $${theirNo.toFixed(2)}${yesAmericanBit(tapeYes)}${cnt}`;
    else if (tapeYes != null) text += `\nTape YES @ $${Number(tapeYes).toFixed(2)}${yesAmericanBit(tapeYes)}${cnt}`;
    const delta = outbidDelta(ourNo, theirNo);
    if (delta != null && delta > 0) {
      const ourAm = formatAmerican(americanFromProb(ourYes));
      const theirAm = formatAmerican(americanFromProb(tapeYes));
      const gap = (ourAm && theirAm) ? ` (YES ${ourAm} vs ${theirAm})` : '';
      text += `\nOutbid by $${delta.toFixed(2)} on NO${gap}`;
    }
    return text;
  }

  let text = `📉 LOST (${reason}) — ${name}\nRFQ ${rfq}\nNo clean tape match`;
  if (ourLine) text += `\n${ourLine}`;
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
  shouldAlertLost,
  outbidDelta,
  fmtCount,
  shortId,
};
