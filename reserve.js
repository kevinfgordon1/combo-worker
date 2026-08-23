// Outstanding-quote reservation against a parlay's max_contracts ceiling.
//
// remaining = max - filled - outstanding.
// A new quote (or a confirm) must fit in remaining. "Outstanding" is live
// unfilled quoted size we already posted — pendingQuotes (plus a brief
// pre-POST reserve: key). Released on fill, cancel, POST fail, RFQ close
// (rfq_deleted), or TTL — dead quotes must not pin remaining.
'use strict';

// Combo RFQs recycle ~10s. Long enough that a still-open RFQ is not dropped
// mid-quote; short enough a 10s no-accept cycle cannot pile reserved size.
// quote-watcher ages unaccepted quotes to 'lost' at 30s; stay inside that.
const RESERVE_TTL_MS = 25_000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parlayIdOf(q) {
  if (!q) return null;
  return q.parlayId != null ? q.parlayId : q.parlay_id;
}

function quoteIdOf(q, fallbackId) {
  if (q && (q.quoteId || q.quote_id)) return q.quoteId || q.quote_id;
  return fallbackId;
}

function isReserveKey(id) {
  return id != null && String(id).startsWith('reserve:');
}

function rfqIdOf(q) {
  if (!q) return null;
  const id = q.rfqId != null ? q.rfqId : q.rfq_id;
  return id != null ? String(id) : null;
}

function postedAtMs(q) {
  if (!q) return null;
  const t = q.postedAt != null ? q.postedAt
    : q.posted_at != null ? q.posted_at
      : q.created_at != null ? q.created_at
        : null;
  if (t == null || t === '') return null;
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) return null;
    return t < 1e12 ? t * 1000 : t;
  }
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

// Seed / restart: only rows young enough that the RFQ could still be open.
// Hours-old is_live + quote_id + no order_id rows are dead (Cards/Pirates:
// 14 such rows totaling 1309 pinned remaining at 18 for hours).
function isFreshOutstanding(q, now = Date.now(), ttlMs = RESERVE_TTL_MS) {
  const at = postedAtMs(q);
  if (at == null) return false;
  return now - at < ttlMs;
}

function selectSeedableOutstanding(rows, now = Date.now(), ttlMs = RESERVE_TTL_MS) {
  return (rows || []).filter((row) => row && row.quote_id && isFreshOutstanding(row, now, ttlMs));
}

// Drop every pendingQuotes entry for this RFQ, including reserve: keys.
// Does not DELETE the quote — RFQ is already gone (404 is success anyway).
function dropPendingForRfq(quotes, rfqId) {
  if (!quotes || rfqId == null || typeof quotes.delete !== 'function') return [];
  const want = String(rfqId);
  const dropped = [];
  quotes.forEach((q, id) => {
    if (rfqIdOf(q) === want) dropped.push({ id, quote: q });
  });
  for (const { id } of dropped) quotes.delete(id);
  return dropped;
}

// Safety net if rfq_deleted is missed. Just-posted quotes (postedAt ≈ now) stay.
function sweepStalePending(quotes, now = Date.now(), ttlMs = RESERVE_TTL_MS) {
  if (!quotes || typeof quotes.delete !== 'function') return [];
  const dropped = [];
  quotes.forEach((q, id) => {
    const at = postedAtMs(q);
    if (at == null) return;
    if (now - at >= ttlMs) dropped.push({ id, quote: q });
  });
  for (const { id } of dropped) quotes.delete(id);
  return dropped;
}

// Sum live unfilled quoted size for one parlay.
// `quotes` is a Map (pendingQuotes) and/or an array of combo_submissions-like rows.
// `excludeQuoteId` skips that quote (the one we are about to confirm / this RFQ).
function sumOutstanding(quotes, parlayId, excludeQuoteId) {
  if (parlayId == null || !quotes) return 0;
  let n = 0;
  const seen = new Set();
  const add = (id, q) => {
    if (!q || parlayIdOf(q) !== parlayId) return;
    const qid = quoteIdOf(q, id);
    if (excludeQuoteId != null && qid === excludeQuoteId) return;
    if (qid != null) {
      if (seen.has(qid)) return;
      seen.add(qid);
    }
    n += num(q.contracts);
  };
  if (typeof quotes.forEach === 'function' && !Array.isArray(quotes)) {
    quotes.forEach((q, id) => add(id, q));
  } else if (Array.isArray(quotes)) {
    for (const q of quotes) add(q && (q.quote_id || q.quoteId), q);
  }
  return n;
}

// pendingQuotes + combo_submissions rows, no double-count on quote_id.
function mergeOutstanding(pendingQuotes, rows, parlayId, excludeQuoteId) {
  const map = new Map();
  if (pendingQuotes && typeof pendingQuotes.forEach === 'function') {
    pendingQuotes.forEach((q, id) => {
      if (parlayIdOf(q) === parlayId) map.set(quoteIdOf(q, id), q);
    });
  }
  for (const row of rows || []) {
    const id = row && (row.quote_id || row.quoteId);
    if (!id || map.has(id)) continue;
    map.set(id, {
      parlayId: row.parlay_id != null ? row.parlay_id : row.parlayId,
      contracts: row.contracts,
      quote_id: id,
    });
  }
  return sumOutstanding(map, parlayId, excludeQuoteId);
}

// remaining after filled AND already-outstanding quotes.
function remainingAfterReserve(maxContracts, filledSoFar, outstanding) {
  if (!(maxContracts > 0)) return null;
  return Math.max(0, maxContracts - num(filledSoFar) - num(outstanding));
}

// True when filled + outstanding + thisSize would go over the ceiling.
// Equal to max is allowed (exactly filling the cap).
function wouldExceedCap(maxContracts, filledSoFar, outstanding, thisSize) {
  if (!(maxContracts > 0)) return false;
  return num(filledSoFar) + num(outstanding) + num(thisSize) > maxContracts;
}

function isCapExhausted(maxContracts, filledSoFar) {
  return maxContracts > 0 && num(filledSoFar) >= maxContracts;
}

module.exports = {
  RESERVE_TTL_MS,
  sumOutstanding,
  mergeOutstanding,
  remainingAfterReserve,
  wouldExceedCap,
  isCapExhausted,
  isReserveKey,
  postedAtMs,
  isFreshOutstanding,
  selectSeedableOutstanding,
  dropPendingForRfq,
  sweepStalePending,
};
