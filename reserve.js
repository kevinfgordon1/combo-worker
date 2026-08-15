// Outstanding-quote reservation against a parlay's max_contracts ceiling.
//
// remaining = max - filled.
// available = remaining - outstanding.
// A new quote (or a confirm) must fit in available. "Outstanding" is live
// unfilled quoted size we already posted — pendingQuotes and/or combo_submissions
// with quote_id, is_live, no order_id.
'use strict';

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
  sumOutstanding,
  mergeOutstanding,
  remainingAfterReserve,
  wouldExceedCap,
  isCapExhausted,
  isReserveKey,
};
