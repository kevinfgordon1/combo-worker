// Skip-reason + targeted public-tape lookup for RFQs we declined (oversized / cap).
// Pure helpers plus one reconcile function. No firehose, no quote-watcher.
'use strict';
const { parseTs } = require('./started');
const { toNum, normalizeTrade, matchTapeTrades } = require('./tape');

// Same pad as quote-watcher: RFQ close → public print delay.
const TAPE_PAD_MS = 45000;
const SKIP_REASONS = Object.freeze(['oversized', 'limit_reached']);

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

function isTrackedSkipReason(reason) {
  return SKIP_REASONS.includes(reason);
}

function isSkipTapeEligible({ skipReason, tapeMatch, parlayActive, started, now, startsAt }) {
  if (!isTrackedSkipReason(skipReason)) return false;
  if (tapeMatch != null && tapeMatch !== '') return false;
  if (!parlayActive) return false;
  if (started) return false;
  if (startsAt != null && startsAt !== '') {
    const t = typeof startsAt === 'number' ? startsAt : Date.parse(startsAt);
    if (Number.isFinite(t) && now >= t) return false;
  }
  return true;
}

function tapeFieldsFromMatch(result) {
  if (result && result.match === 'matched') {
    return {
      tape_match: 'matched',
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
    return { retry: true };
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
  const result = matchTapeTrades(normalized, {
    rfqCount: rfqCountForTape(rfq, row.contracts),
    closedMs,
  });
  const patch = tapeFieldsFromMatch(result);
  patch.market_ticker = ticker;
  return { retry: false, patch, result };
}

module.exports = {
  TAPE_PAD_MS,
  SKIP_REASONS,
  classifySkip,
  skipPersistExtra,
  isTrackedSkipReason,
  isSkipTapeEligible,
  tapeFieldsFromMatch,
  rfqClosedMs,
  isTapeReady,
  rfqCountForTape,
  resolveSkipTape,
};
