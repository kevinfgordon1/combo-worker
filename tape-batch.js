// Batched public-tape matching for closed Combo Lock RFQs ("checking who won").
// Pure helpers — no I/O, places nothing.
//
// Kalshi's public trades carry no RFQ / quote id, so a print is credited to a closed
// request by size + time. The old per-row lookup let every request near a print claim
// it (1,685 "outbid at X" rows over 7 days pointed at only 273 distinct trades).
// Here each trade goes to at most ONE request: the one whose close is nearest (exact
// size preferred). Requests left without a trade are "not taken" (no_print).
'use strict';
const { normalizeTrade, countClose, toNum } = require('./tape');

const TAPE_PAD_MS = 45000; // RFQ close → public print delay (same pad as skip-tape)
const NEAR_CLOSE_MS = 10000; // no request size known: print must sit this close to the close
const INEXACT_SIZE_PENALTY_MS = 5000; // size within 5% / 1 contract but not exact
// A closed-live row is stamped while OUR quote is still pending, and unaccepted quotes
// are cancelled at ~20s, so a legacy row (no stored close time) closed within this of create.
const LEGACY_CLOSE_SPAN_MS = 21000;

function parseMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function tradeId(t) {
  if (!t) return null;
  const raw = t.raw || t;
  return raw.trade_id || raw.id || null;
}

// Row → matching window. closedMs known (from the rfq_deleted event): exact close.
// Legacy rows: close lies in [created, created + LEGACY_CLOSE_SPAN_MS].
function rowWindow(row, { padMs = TAPE_PAD_MS } = {}) {
  const createdMs = parseMs(row && (row.createdMs != null ? row.createdMs : row.created_at));
  const closedMs = parseMs(row && (row.closedMs != null ? row.closedMs : row.rfq_closed_at));
  if (createdMs == null && closedMs == null) return null;
  const closeLo = closedMs != null ? closedMs : createdMs;
  const closeHi = closedMs != null ? closedMs : createdMs + LEGACY_CLOSE_SPAN_MS;
  const start = (createdMs != null ? Math.min(createdMs, closeLo) : closeLo) - 1000;
  return { start, end: closeHi + padMs, closeLo, closeHi, exactClose: closedMs != null };
}

function rfqCountOf(row) {
  const n = toNum(row && (row.rfqCount != null ? row.rfqCount : row.rfq_contracts));
  return n != null && n > 0 ? n : null;
}

// Lower is better; null = this trade cannot be this request's fill.
function pairScore(row, trade, opts = {}) {
  const w = row._win || rowWindow(row, opts);
  if (!w || !trade || trade.ts == null || !(trade.count > 0)) return null;
  if (trade.ts < w.start || trade.ts > w.end) return null;
  const dt = trade.ts < w.closeLo ? w.closeLo - trade.ts : (trade.ts > w.closeHi ? trade.ts - w.closeHi : 0);
  const want = rfqCountOf(row);
  if (want != null) {
    if (!countClose(trade.count, want)) return null;
    return dt + (Math.abs(trade.count - want) <= 0.01 ? 0 : INEXACT_SIZE_PENALTY_MS);
  }
  return dt <= NEAR_CLOSE_MS ? dt : null;
}

// rows: [{ id, created_at|createdMs, rfq_closed_at|closedMs, rfq_contracts|rfqCount }]
// trades: raw Kalshi trades (or already-normalized) for ONE ticker.
// claimed: trade ids already credited to an earlier resolved request — never reused.
// Returns Map(rowId → normalized trade) — each trade to at most one row.
function assignTrades(rows, trades, { padMs = TAPE_PAD_MS, claimed = null, parseTs = parseMs } = {}) {
  const norm = (trades || []).map((t) => (t && t.raw && 'count' in t ? t : normalizeTrade(t, parseTs)))
    .filter((t) => t && t.ts != null && t.count > 0 && (t.yes != null || t.no != null))
    .filter((t) => !(claimed && tradeId(t) && claimed.has(tradeId(t))));
  const pairs = [];
  for (const row of rows || []) {
    if (!row || row.id == null) continue;
    const w = rowWindow(row, { padMs });
    if (!w) continue;
    const r = { ...row, _win: w };
    norm.forEach((t, ti) => {
      const s = pairScore(r, t, { padMs });
      if (s != null) {
        const mid = (w.closeLo + w.closeHi) / 2;
        pairs.push({ rowId: row.id, ti, s, tie: Math.abs(t.ts - mid) });
      }
    });
  }
  pairs.sort((a, b) => (a.s - b.s) || (a.tie - b.tie) || (String(a.rowId) < String(b.rowId) ? -1 : 1));
  const out = new Map();
  const usedTrades = new Set();
  for (const p of pairs) {
    if (out.has(p.rowId) || usedTrades.has(p.ti)) continue;
    out.set(p.rowId, norm[p.ti]);
    usedTrades.add(p.ti);
  }
  return out;
}

// One row's DB patch from the assignment. Matched → outbid with the winning price;
// no trade left for it → no_print ("Not taken").
function patchFor(row, trade, ticker) {
  if (trade) {
    return {
      skip_reason: 'outbid',
      tape_match: 'matched',
      tape_yes_price: trade.yes != null ? trade.yes : null,
      tape_no_price: trade.no != null ? trade.no : null,
      tape_trade_ts: new Date(trade.ts).toISOString(),
      tape_trade_id: tradeId(trade),
      market_ticker: ticker || row.market_ticker || null,
    };
  }
  return {
    skip_reason: 'no_print',
    tape_match: 'none',
    tape_yes_price: null,
    tape_no_price: null,
    tape_trade_ts: null,
    tape_trade_id: null,
    market_ticker: ticker || row.market_ticker || null,
  };
}

// Time span to fetch for a set of rows on one ticker (unix seconds, for /markets/trades).
function fetchSpan(rows, { padMs = TAPE_PAD_MS } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of rows || []) {
    const w = rowWindow(row, { padMs });
    if (!w) continue;
    lo = Math.min(lo, w.start);
    hi = Math.max(hi, w.end);
  }
  if (!Number.isFinite(lo)) return null;
  return { minTs: Math.max(0, Math.floor(lo / 1000) - 1), maxTs: Math.ceil(hi / 1000) + 1 };
}

// Due = close known and the print pad has elapsed.
function isBatchDue(row, now, { padMs = TAPE_PAD_MS } = {}) {
  const closedMs = parseMs(row && (row.closedMs != null ? row.closedMs : row.rfq_closed_at));
  return closedMs != null && now >= closedMs + padMs;
}

// Group batchable rows by ticker, tickers with the oldest due row first.
function groupByTicker(rows) {
  const m = new Map();
  for (const row of rows || []) {
    const t = row && row.market_ticker;
    if (!t) continue;
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(row);
  }
  return m;
}

module.exports = {
  TAPE_PAD_MS,
  NEAR_CLOSE_MS,
  LEGACY_CLOSE_SPAN_MS,
  INEXACT_SIZE_PENALTY_MS,
  parseMs,
  tradeId,
  rowWindow,
  pairScore,
  assignTrades,
  patchFor,
  fetchSpan,
  isBatchDue,
  groupByTicker,
};
