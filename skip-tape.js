// Skip-reason + targeted public-tape lookup for RFQs we declined (oversized / cap).
// insufficient_balance is a lock-card / Miss-tape skip_reason but is NOT
// tape-eligible — we never posted, so there is no public print to match.
// rfq_closed (late quote POST) is persist-only on combo_submissions — same.
// Pure helpers plus one reconcile function. No firehose, no quote-watcher.
'use strict';
const { parseTs } = require('./started');
const { toNum, normalizeTrade, matchTapeTrades } = require('./tape');

// Same pad as quote-watcher: RFQ close → public print delay.
const TAPE_PAD_MS = 45000;
// rfq_closed_live: the RFQ closed while OUR quote was still live (someone else won it, or the
// buyer walked away). Resolved after the tape pad into 'outbid' (closed, not cancelled —
// tape_yes_price holds the winning YES when the print is found) or 'no_taker' (requester cancelled).
const CLOSED_LIVE = 'rfq_closed_live';
const SKIP_REASONS = Object.freeze(['oversized', 'limit_reached', CLOSED_LIVE]);

// NO_PRINT: RFQ closed (not cancelled) but the combo ticker printed no trade at all
// in the RFQ window — nobody (us or another maker) was filled, so it is not "outbid".
const NO_PRINT = 'no_print';
// Fallback when no print matches the RFQ size: one price printed within this many ms of close.
const NEAR_CLOSE_MS = 10000;

function finalizeClosedLive(rfq, patch, windowTrades = null) {
  const cancelled = !!(rfq && (rfq.cancelled_ts || rfq.cancellation_reason));
  const matched = !!(patch && (patch.tape_match === 'matched' || patch.tape_match === 'matched_time'));
  if (matched) return 'outbid';
  if (cancelled) return 'no_taker';
  return windowTrades === 0 ? NO_PRINT : 'outbid';
}

// Size match failed: take the print(s) closest to RFQ close if they agree on one price.
function nearCloseMatch(trades, closedMs, ms = NEAR_CLOSE_MS) {
  if (closedMs == null) return { match: 'none' };
  const near = (trades || []).filter((t) => t && t.ts != null && t.count > 0 && t.yes != null
    && Math.abs(t.ts - closedMs) <= ms);
  if (!near.length) return { match: 'none' };
  const prices = new Set(near.map((t) => Math.round(t.yes * 10000)));
  if (prices.size !== 1) return { match: 'ambiguous' };
  near.sort((a, b) => Math.abs(a.ts - closedMs) - Math.abs(b.ts - closedMs));
  const best = near[0];
  return { match: 'matched_time', trade: best, yesPrice: best.yes, noPrice: best.no, count: best.count, tradeTs: best.ts };
}

function classifySkip(decision) {
  if (!decision || decision.ok) return null;
  if (decision.reason === 'limit_reached') return 'limit_reached';
  if (decision.reason === 'rfq_too_large') return 'oversized';
  return null;
}

function skipPersistExtra({ skipReason, contracts, remaining, marketTicker }) {
  const extra = {};
  if (skipReason) extra.skip_reason = skipReason;
  if (contracts != null) extra.contracts = contracts;
  if (remaining != null) extra.remaining = remaining;
  if (marketTicker) extra.market_ticker = marketTicker;
  return extra;
}

// Miss tape chips (aibetbuilder #61) read combo_submissions.venue.
// extra.venue wins when the caller already set kalshi | polymarket.
function withVenue(extra = {}, fallback = 'kalshi') {
  const src = extra && typeof extra === 'object' ? extra : {};
  return { ...src, venue: src.venue || fallback };
}

function isTrackedSkipReason(reason) {
  return SKIP_REASONS.includes(reason);
}

function isSkipTapeEligible({ skipReason, tapeMatch, parlayActive, started, now, startsAt }) {
  if (!isTrackedSkipReason(skipReason)) return false;
  if (tapeMatch != null && tapeMatch !== '') return false;
  // rfq_closed_live: the RFQ already closed BEFORE the game (our quote was live on it), and the
  // Kalshi RFQ + trade history stay readable afterwards. Dropping these at kickoff / lock end left
  // the card on "checking who won" forever, so they resolve regardless of lock state.
  if (skipReason === CLOSED_LIVE) return true;
  if (!parlayActive) return false;
  if (started) return false;
  if (startsAt != null && startsAt !== '') {
    const t = typeof startsAt === 'number' ? startsAt : Date.parse(startsAt);
    if (Number.isFinite(t) && now >= t) return false;
  }
  return true;
}

function tapeFieldsFromMatch(result) {
  if (result && (result.match === 'matched' || result.match === 'matched_time')) {
    return {
      tape_match: result.match,
      tape_yes_price: result.yesPrice != null ? result.yesPrice : null,
      tape_no_price: result.noPrice != null ? result.noPrice : null,
      tape_trade_ts: result.tradeTs != null ? new Date(result.tradeTs).toISOString() : null,
    };
  }
  return {
    tape_match: 'none',
    tape_yes_price: null,
    tape_no_price: null,
    tape_trade_ts: null,
  };
}

function rfqClosedMs(rfq) {
  if (!rfq) return null;
  return parseTs(rfq.updated_ts) || parseTs(rfq.cancelled_ts) || parseTs(rfq.closed_ts) || null;
}

function isTapeReady({ status, closedMs, now, padMs = TAPE_PAD_MS }) {
  if (status === 'open') return false;
  if (closedMs != null && now < closedMs + padMs) return false;
  if (status == null && closedMs == null) return false;
  return true;
}

// Retry scheduling so one row that keeps answering "not ready" (an oversized RFQ the requester
// leaves open for hours) cannot hold a per-tick slot forever and stall every row behind it.
const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 5 * 60 * 1000;

function retryDelayMs(attempts) {
  const n = Math.max(0, Math.floor(Number(attempts) || 0));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n, 10));
}

// When to look at a row again after resolveSkipTape said retry.
function nextRetryAt(out, attempts, now) {
  const backoff = now + retryDelayMs(attempts);
  if (out && out.readyAt != null && Number.isFinite(out.readyAt) && out.readyAt > now) {
    return Math.min(backoff, out.readyAt + 1000);
  }
  return backoff;
}

function createdMs(row) {
  const t = row && row.created_at ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Pick up to max due rows: closed-live first (the RFQ is already closed, the UI is waiting on it),
// then oldest first. Rows still backing off are skipped and do not use a slot.
function pickSkipTapeBatch(rows, now, max) {
  const due = [];
  for (const row of rows) {
    if (!row) continue;
    if (row._nextAt != null && row._nextAt > now) continue;
    due.push(row);
  }
  due.sort((a, b) => {
    const pa = a.skip_reason === CLOSED_LIVE ? 0 : 1;
    const pb = b.skip_reason === CLOSED_LIVE ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return createdMs(a) - createdMs(b);
  });
  return due.slice(0, Math.max(0, max));
}

function rfqCountForTape(rfq, fallbackContracts) {
  const fromRfq = toNum(rfq && (rfq.contracts_fp != null ? rfq.contracts_fp : rfq.contracts));
  if (fromRfq > 0) return fromRfq;
  const stored = toNum(fallbackContracts);
  return stored > 0 ? stored : null;
}

function tickerOf(rfq, row) {
  return (row && row.market_ticker)
    || (rfq && (rfq.market_ticker || rfq.ticker))
    || null;
}

// One RFQ GET + at most one trades GET for THAT ticker. Never guesses a price.
// retry: RFQ still open or pad not elapsed (or fetch failed — caller retries).
async function resolveSkipTape(row, { fetchRfq, fetchTrades, now = Date.now(), padMs = TAPE_PAD_MS } = {}) {
  if (!row || !row.rfq_id) return { retry: false, patch: tapeFieldsFromMatch({ match: 'none' }) };

  let rfq;
  try {
    rfq = await fetchRfq(row.rfq_id);
  } catch (e) {
    return { retry: true, error: e };
  }
  if (!rfq) {
    return { retry: false, patch: tapeFieldsFromMatch({ match: 'none' }) };
  }

  const closedMs = rfqClosedMs(rfq);
  if (!isTapeReady({ status: rfq.status, closedMs, now, padMs })) {
    const readyAt = rfq.status !== 'open' && closedMs != null ? closedMs + padMs : null;
    return { retry: true, readyAt, status: rfq.status || null };
  }

  const ticker = tickerOf(rfq, row);
  if (!ticker) {
    return { retry: false, patch: tapeFieldsFromMatch({ match: 'none' }) };
  }

  const created = parseTs(rfq.created_ts);
  const minTs = Math.max(0, Math.floor((created || closedMs || now) / 1000) - 1);
  const maxTs = Math.ceil(((closedMs || now) + padMs) / 1000);
  let trades;
  try {
    trades = await fetchTrades(ticker, minTs, maxTs);
  } catch (e) {
    return { retry: true, error: e };
  }

  const windowStart = created || 0;
  const windowEnd = (closedMs || now) + padMs;
  const normalized = (trades || []).map((t) => normalizeTrade(t, parseTs))
    .filter((t) => t.ts == null || (t.ts >= windowStart - 1000 && t.ts <= windowEnd + 1000));
  let result = matchTapeTrades(normalized, {
    rfqCount: rfqCountForTape(rfq, row.contracts),
    closedMs,
  });
  if (result.match !== 'matched') {
    const near = nearCloseMatch(normalized, closedMs);
    if (near.match === 'matched_time') result = near;
  }
  const patch = tapeFieldsFromMatch(result);
  patch.market_ticker = ticker;
  return { retry: false, patch, result, rfq, windowTrades: normalized.length };
}

module.exports = {
  TAPE_PAD_MS,
  SKIP_REASONS,
  CLOSED_LIVE,
  NO_PRINT,
  NEAR_CLOSE_MS,
  nearCloseMatch,
  finalizeClosedLive,
  classifySkip,
  skipPersistExtra,
  withVenue,
  isTrackedSkipReason,
  isSkipTapeEligible,
  tapeFieldsFromMatch,
  rfqClosedMs,
  isTapeReady,
  rfqCountForTape,
  resolveSkipTape,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  retryDelayMs,
  nextRetryAt,
  pickSkipTapeBatch,
};
