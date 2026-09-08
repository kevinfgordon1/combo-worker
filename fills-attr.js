'use strict';
const { fillView } = require('./engine');
const { shortId } = require('./short-id');

const CENT = 0.01;

function collectionPrefix(collection) {
  return String(collection || '').trim().toUpperCase().replace(/-[RS]$/i, '');
}

// ticker.includes(collection), ticker.startsWith(collection), or the same after
// stripping a trailing -R / -S on the stored collection (Kalshi series suffix).
function tickerMatchesCollection(ticker, collection) {
  if (!ticker || !collection) return false;
  const t = String(ticker).toUpperCase();
  const c = String(collection).trim().toUpperCase();
  if (!c) return false;
  if (t.includes(c) || t.startsWith(c)) return true;
  const prefix = collectionPrefix(c);
  if (prefix && prefix !== c && (t.includes(prefix) || t.startsWith(prefix))) return true;
  return false;
}

function noBidMatchesFill(fillNoPrice, fillAmerican) {
  if (fillNoPrice == null || fillAmerican == null || fillAmerican === '') return false;
  const quoted = parseFloat(fillView(fillAmerican).noBid);
  const actual = Number(fillNoPrice);
  if (!Number.isFinite(quoted) || !Number.isFinite(actual)) return false;
  return Math.abs(actual - quoted) <= CENT + 1e-9;
}

// Best-effort only. Never guess when more than one parlay still fits.
function attributeParlay(ticker, fill, parlays) {
  if (!Array.isArray(parlays) || !parlays.length) return null;
  const collectionHits = parlays.filter((p) => tickerMatchesCollection(ticker, p.mve_collection));
  if (collectionHits.length === 1) return collectionHits[0];

  const pool = collectionHits.length > 1 ? collectionHits : parlays;
  const priceHits = pool.filter((p) => p.active && noBidMatchesFill(fill && fill.no_price, p.fill_american));
  if (priceHits.length === 1) return priceHits[0];
  return null;
}

// Kalshi CROSSCATEGORY shard tickers (KXMVECROSSCATEGORY0-SHARD1-…) do not
// contain the stored KXMVESPORTSMULTIGAMEEXTENDED-R collection, so collection
// matching misses. Quote/order rows on combo_submissions are stronger evidence
// than a no_bid fallback when several locks sit near the same American.
const QUOTE_WINDOW_BEFORE_MS = 120000;
const QUOTE_WINDOW_AFTER_MS = 30000;
const PARTIAL_FILL_RATIO = 0.85;

function tsMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function uniqueParlayIds(rows) {
  const ids = [];
  const seen = new Set();
  for (const row of rows || []) {
    const id = row && row.parlay_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isQuoteCandidate(sub) {
  if (!sub || !sub.quote_id || !sub.parlay_id) return false;
  const st = String(sub.status || '').toLowerCase();
  if (st === 'declined' || st === 'shadow' || st === 'limitreached') return false;
  return true;
}

function contractsCoverFill(subContracts, fillCount) {
  const have = Number(subContracts);
  const need = Number(fillCount);
  if (!Number.isFinite(have) || !Number.isFinite(need) || !(need > 0)) return false;
  return have + 1e-9 >= need * PARTIAL_FILL_RATIO;
}

function parlayById(parlays, id) {
  if (!id || !Array.isArray(parlays)) return null;
  return parlays.find((p) => p && p.id === id) || null;
}

// Match a Kalshi fill to the quote we posted (order_id, or unique parlay in
// the recent quote window). Never guess when two parlays still fit.
function attributeFromSubmissions(fill, submissions, parlays = []) {
  if (!fill || !Array.isArray(submissions) || !submissions.length) return null;

  if (fill.order_id) {
    const byOrder = submissions.filter((s) => s && s.order_id && s.order_id === fill.order_id);
    const ids = uniqueParlayIds(byOrder);
    if (ids.length === 1) {
      return {
        parlay: parlayById(parlays, ids[0]) || { id: ids[0] },
        submission: byOrder[0],
        reason: 'order_id',
      };
    }
  }

  const fillTs = tsMs(fill.kalshi_created_time || fill.created_time);
  if (!fillTs) return null;

  const windowed = submissions.filter((s) => {
    if (!isQuoteCandidate(s)) return false;
    const t = tsMs(s.created_at);
    if (!t) return false;
    if (t < fillTs - QUOTE_WINDOW_BEFORE_MS || t > fillTs + QUOTE_WINDOW_AFTER_MS) return false;
    return contractsCoverFill(s.contracts, fill.count);
  });
  const ids = uniqueParlayIds(windowed);
  if (ids.length !== 1) return null;

  const chosen = windowed.slice().sort((a, b) => {
    const da = Math.abs(fillTs - tsMs(a.created_at));
    const db = Math.abs(fillTs - tsMs(b.created_at));
    return da - db;
  })[0];
  return {
    parlay: parlayById(parlays, ids[0]) || { id: ids[0] },
    submission: chosen,
    reason: 'quote_window',
  };
}

function attributeFromExistingFills(fill, existingFills, parlays = []) {
  if (!fill || !fill.order_id || !Array.isArray(existingFills)) return null;
  const twins = existingFills.filter((f) => (
    f && f.order_id === fill.order_id && f.parlay_id
    && (!fill.fill_id || f.fill_id !== fill.fill_id)
  ));
  const ids = uniqueParlayIds(twins);
  if (ids.length !== 1) return null;
  return {
    parlay: parlayById(parlays, ids[0]) || { id: ids[0] },
    submission: null,
    reason: 'order_id_fill',
  };
}

// Collection / no_bid first (unchanged). Quote/order rows recover shard
// tickers and the case where several locks share a no_bid.
function attributeComboFill(ticker, fill, parlays, extras = {}) {
  const fromOrder = attributeFromSubmissions(fill, extras.submissions, parlays);
  if (fromOrder && fromOrder.reason === 'order_id') return fromOrder;

  const fromTwin = attributeFromExistingFills(fill, extras.existingFills, parlays);
  if (fromTwin) return fromTwin;

  const parlay = attributeParlay(ticker, fill, parlays);
  if (parlay) {
    const stamp = attributeFromSubmissions(fill, extras.submissions, parlays);
    const submission = stamp && stamp.parlay && stamp.parlay.id === parlay.id ? stamp.submission : null;
    return { parlay, submission, reason: 'collection_or_price' };
  }

  const fromQuotes = attributeFromSubmissions(fill, extras.submissions, parlays);
  if (fromQuotes) return fromQuotes;
  return null;
}

function submissionFilledPatch(fill, extra = {}) {
  const orderId = (fill && fill.order_id) || extra.orderId || null;
  return {
    status: 'filled',
    order_id: orderId,
    is_live: true,
  };
}

function canStampSubmission(sub, fill) {
  if (!sub || !sub.id) return false;
  const st = String(sub.status || '').toLowerCase();
  if (st === 'shadow') return false;
  if (sub.order_id && fill && fill.order_id && sub.order_id !== fill.order_id) return false;
  return true;
}

function liveRunnerFillRow({ quoteId, orderId, parlayId, count, ticker, rfqId, label, createdAt }) {
  const fillId = orderId || quoteId;
  return {
    fill_id: fillId,
    order_id: orderId || null,
    parlay_id: parlayId || null,
    ticker: ticker || null,
    count,
    is_combo: true,
    is_taker: false,
    outcome_side: 'no',
    action: 'sell',
    kalshi_created_time: createdAt || new Date().toISOString(),
    raw: { source: 'live-runner', quote_id: quoteId || null, rfq_id: rfqId || null, label: label || null },
  };
}

function existingFillNeedsParlay(existing, parlayId) {
  if (!parlayId) return false;
  if (!existing) return true;
  return !existing.parlay_id;
}

function isLiveRunnerTwin(row) {
  if (!row) return false;
  if (row.raw && row.raw.source === 'live-runner') return true;
  return !!(row.fill_id && row.order_id && row.fill_id === row.order_id);
}

function pickFillForSum(rows) {
  const list = (rows || []).filter(Boolean);
  const byKey = new Map();
  for (const row of list) {
    const key = row.order_id || row.fill_id;
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    if (isLiveRunnerTwin(prev) && !isLiveRunnerTwin(row)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function sumAttributedFillCounts(rows) {
  return sumFillCounts(pickFillForSum(rows));
}

function sumFillCounts(rows) {
  if (!Array.isArray(rows)) return null;
  let sum = 0;
  for (const r of rows) {
    const n = Number(r && r.count);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

function remainingContracts(maxContracts, filled) {
  if (filled == null || maxContracts == null || maxContracts === '') return null;
  const max = Number(maxContracts);
  const have = Number(filled);
  if (!(max > 0) || !Number.isFinite(have)) return null;
  return Math.max(0, max - have);
}

function formatQty(n) {
  if (n == null || n === '') return '?';
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return String(x);
}

function formatRealFillAlert({ parlay, row, filled = null }) {
  const price = row.no_price ?? row.yes_price ?? '?';
  const fillRef = shortId(row.fill_id);

  if (!parlay) {
    return (
      `💰 REAL FILL (from Kalshi account) — ${row.ticker}\n` +
      `${row.action || ''} ${row.count} contracts · ${row.outcome_side || ''} @ $${price}\n` +
      `unattributed combo fill · fill ${fillRef}`
    );
  }

  const side = row.outcome_side ? String(row.outcome_side).toUpperCase() : '';
  const mid = [row.action || '', formatQty(row.count), side].filter(Boolean).join(' ');
  const left = remainingContracts(parlay.max_contracts, filled);
  const sessionLine = left != null
    ? `session ${formatQty(filled)}/${formatQty(parlay.max_contracts)} · ${formatQty(left)} left · fill ${fillRef}`
    : `fill ${fillRef}`;

  return `💰 REAL FILL — ${parlay.label}\n${mid} @ $${price}\n${sessionLine}`;
}

module.exports = {
  tickerMatchesCollection,
  attributeParlay,
  attributeFromSubmissions,
  attributeFromExistingFills,
  attributeComboFill,
  submissionFilledPatch,
  canStampSubmission,
  liveRunnerFillRow,
  existingFillNeedsParlay,
  isLiveRunnerTwin,
  pickFillForSum,
  sumAttributedFillCounts,
  contractsCoverFill,
  isQuoteCandidate,
  sumFillCounts,
  remainingContracts,
  formatRealFillAlert,
  noBidMatchesFill,
  QUOTE_WINDOW_BEFORE_MS,
  QUOTE_WINDOW_AFTER_MS,
};
