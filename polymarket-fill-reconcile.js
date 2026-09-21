// Durable Polymarket Combo Lock fill recovery.
//
// Live WS orderExecution is the fast path. It is not sufficient:
// quoteExecuted only means paired orders were submitted, ORDER fills can
// arrive after polyPendingQuotes TTL, and Retail docs say to reconcile
// fills via GetQuotes + the order snapshot (Drop Copy / GET /v1/order).
// This module turns those durable reads into the same onQuoteExecuted
// events live-runner already persists (combo_fills + filled submissions
// + Telegram).
//
// Retail activity for Combo markets uses opaque slugs (caoc-*) and empty
// marketMetadata.title. Do not invent titles — join marketSlug to quote /
// order / fill / submission ticker records we already stored.
// Reconcile never attaches an order whose cumQuantity ≠ posted quote size
// (partials may be smaller). Activity / reconcile / position share one
// economic size: same lock + caoc slug + size books once. claimFillKey
// cannot catch this — fill_ids are poly-act: / poly-recon: / poly-pos:.
// Activity never re-books a trade already booked via poly-recon,
// poly-position, or a prior activity of the same lock/slug + size
// (2026-09-21 06:41 UTC re-booked Ravens 629.82 and Cubs 83.57 on top
// of existing reconcile rows). Reconcile never duplicates an
// activity/position row of that size. Position is a fallback only — skip
// when the lock already has any poly contracts for that caoc ticker.
// persistExecutedFill also refuses a second economic twin (last line of
// defense when bookedFills is empty after restart).
// Cleanup prefers poly-activity, then poly-reconcile, over poly-position.
//
// Combo Lock hedges are No / short Yes. Position qty must use |netPosition|
// (qtyBoughtDecimal is often "0"). Slug-only maker trades may be smaller
// than a posted quote (partial of 80 → 75.64) but never larger than every
// quote on that lock (629.82 vs 43). Per-slug activity pages catch older
// caoc fills that fall off the global TRADE window.
// Quote/order reconcile never attaches a foreign caoc ticker. A fill books
// onto a lock only when marketSlug matches that lock's mapped caoc or the
// quote_id is one of that lock's submissions. BACKFILL_PARLAY_ID is not a
// fallback for unmatched executed quotes.
'use strict';

const USER_FILTER_SELF = 'USER_FILTER_SELF';
const QUOTE_STATUS_EXECUTED = 'QUOTE_STATUS_EXECUTED';
const DEFAULT_MAX_PER_TICK = 15;

function parsePositive(n) {
  const x = parseFloat(n);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.round(x * 1e8) / 1e8;
}

function amountValue(amt) {
  if (amt == null || amt === '') return 0;
  if (typeof amt === 'object') return parsePositive(amt.value);
  return parsePositive(amt);
}

function quoteIdOf(q) {
  return (q && (q.id || q.quoteId || q.quote_id)) || null;
}

function rfqIdOf(q) {
  return (q && (q.rfqId || q.rfq_id)) || null;
}

function orderIdOfQuote(q) {
  return (q && (q.creatorOrderId || q.creator_order_id)) || null;
}

function symbolOf(q) {
  return (q && (q.symbol || q.marketSlug || q.market_slug)) || null;
}

function normalizeStatus(v) {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/-/g, '_');
}

function isExecutedQuoteStatus(status) {
  const s = normalizeStatus(status);
  return s === 'QUOTE_STATUS_EXECUTED' || s === 'EXECUTED';
}

function orderFromResponse(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.order && typeof body.order === 'object') return body.order;
  if (body.id || body.state || body.cumQuantity != null || body.cum_quantity != null) return body;
  return null;
}

function orderStateOf(order) {
  return normalizeStatus(order && (order.state || order.status));
}

function isPartialOrderState(state) {
  const s = normalizeStatus(state);
  return s === 'ORDER_STATE_PARTIALLY_FILLED' || s === 'PARTIALLY_FILLED';
}

function isFilledOrderState(state) {
  const s = normalizeStatus(state);
  return s === 'ORDER_STATE_FILLED' || s === 'FILLED' || isPartialOrderState(s);
}

function cumQuantityOf(order) {
  if (!order || typeof order !== 'object') return 0;
  return parsePositive(
    order.cumQuantity ?? order.cum_quantity ?? order.filledQty ?? order.filled_qty
    ?? order.cumulativeQty ?? order.totalFilled ?? order.lastShares ?? order.last_shares
  );
}

function contractsFromQuote(q) {
  if (!q || typeof q !== 'object') return 0;
  return parsePositive(
    q.buyQtyDecimal ?? q.buy_qty_decimal ?? q.sellQtyDecimal ?? q.sell_qty_decimal
    ?? q.qtyDecimal ?? q.qty_decimal ?? q.contracts
  );
}

function firstPositiveAmount(...vals) {
  for (const v of vals) {
    const n = amountValue(v);
    if (n > 0) return n;
  }
  return 0;
}

function incrementFromCum(cumQty, alreadyFilled) {
  const cum = parsePositive(cumQty);
  const have = parsePositive(alreadyFilled);
  if (!(cum > 0)) return 0;
  const inc = Math.round((cum - have) * 1e8) / 1e8;
  return inc > 1e-9 ? inc : 0;
}

const SIZE_EPS = 1e-4;

function sizesEqual(a, b) {
  return Math.abs(parsePositive(a) - parsePositive(b)) <= SIZE_EPS;
}

function sizeKey(n) {
  return Math.round(parsePositive(n) / SIZE_EPS);
}

function quotedContractsForReconcile(quote, pending) {
  const pendingQty = pending ? parsePositive(pending.contracts) : 0;
  const quoteQty = contractsFromQuote(quote);
  if (pendingQty > 0 && quoteQty > 0 && !sizesEqual(pendingQty, quoteQty)) {
    return { quoted: 0, mismatch: true, pendingQty, quoteQty };
  }
  return { quoted: pendingQty || quoteQty, mismatch: false, pendingQty, quoteQty };
}

// Full fill must equal the posted quote. PARTIALLY_FILLED may be smaller.
// Never attach a 629.82 order/trade to a 43-contract quote.
function orderQtyMatchesQuoted(cumQty, quoted, state) {
  const cum = parsePositive(cumQty);
  const want = parsePositive(quoted);
  if (!(want > 0)) return true;
  if (!(cum > 0)) return false;
  if (sizesEqual(cum, want)) return true;
  return cum + SIZE_EPS < want && isPartialOrderState(state);
}

function sourceOfFill(row) {
  return String((row && (row.source || (row.raw && row.raw.source))) || '');
}

function fillIdOf(row) {
  return (row && (row.fillId || row.fill_id)) || null;
}

function isReconcileFillRecord(row) {
  if (!row) return false;
  return sourceOfFill(row).startsWith('poly-recon')
    || String(fillIdOf(row) || '').startsWith('poly-recon:');
}

function isActivityFillRecord(row) {
  if (!row) return false;
  return sourceOfFill(row).startsWith('poly-activity')
    || String(fillIdOf(row) || '').startsWith('poly-act:');
}

function isPositionFillRecord(row) {
  if (!row) return false;
  return sourceOfFill(row).startsWith('poly-position')
    || String(fillIdOf(row) || '').startsWith('poly-pos:');
}

function isPolyFillRecord(row) {
  if (!row) return false;
  if (isReconcileFillRecord(row) || isActivityFillRecord(row) || isPositionFillRecord(row)) {
    return true;
  }
  if (sourceOfFill(row).startsWith('poly-')) return true;
  const venue = String((row.venue || (row.raw && row.raw.venue)) || '');
  return venue === 'polymarket' && !!fillIdOf(row);
}

function polyFillQty(row) {
  return parsePositive(row && (row.contracts ?? row.count ?? row.qty));
}

function polyFillKeepRank(row) {
  if (isActivityFillRecord(row)) return 3;
  if (isReconcileFillRecord(row)) return 2;
  if (isPositionFillRecord(row)) return 0;
  return isPolyFillRecord(row) ? 1 : -1;
}

function sizeFromPolyFillId(fillId) {
  const s = String(fillId || '');
  let m = /^poly-recon:[^:]+:(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return parsePositive(m[1]);
  m = /^poly-pos:[^:]+:[^:]+:(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return parsePositive(m[1]);
  return 0;
}

function reconcileSizeFromFillId(fillId) {
  return sizeFromPolyFillId(fillId);
}

function quotedSizesByLock(submissions, pendingQuotes) {
  const map = new Map();
  const add = (parlayId, qty) => {
    const n = parsePositive(qty);
    if (!parlayId || !(n > 0)) return;
    if (!map.has(parlayId)) map.set(parlayId, new Set());
    map.get(parlayId).add(sizeKey(n));
  };
  for (const row of submissions || []) {
    add(row.parlay_id || row.parlayId, row.contracts);
  }
  if (pendingQuotes && typeof pendingQuotes.forEach === 'function') {
    pendingQuotes.forEach((pending) => {
      if (pending) add(pending.parlayId, pending.contracts);
    });
  }
  return map;
}

function bookedPolySizeKeys({ bookedFills, seenFillIds, include } = {}) {
  const want = include || {
    activity: true, reconcile: true, position: true, other: true,
  };
  const keys = new Set();
  const add = (parlayId, slug, qty) => {
    const n = parsePositive(qty);
    if (!(n > 0)) return;
    const sk = sizeKey(n);
    if (parlayId) keys.add(`${parlayId}:${sk}`);
    if (slug) keys.add(`${slug}:${sk}`);
    if (parlayId && slug) keys.add(`${parlayId}:${slug}:${sk}`);
  };
  for (const row of bookedFills || []) {
    if (!isPolyFillRecord(row)) continue;
    if (isActivityFillRecord(row) && !want.activity) continue;
    if (isReconcileFillRecord(row) && !want.reconcile) continue;
    if (isPositionFillRecord(row) && !want.position) continue;
    if (
      !isActivityFillRecord(row) && !isReconcileFillRecord(row) && !isPositionFillRecord(row)
      && !want.other
    ) continue;
    add(
      parlayIdOfRecord(row),
      slugOfRecord(row) || normalizeMarketSlug(row.marketTicker || row.ticker || row.market_ticker),
      polyFillQty(row)
    );
  }
  if (seenFillIds && typeof seenFillIds.forEach === 'function') {
    seenFillIds.forEach((id) => {
      const s = String(id || '');
      if (s.startsWith('poly-recon:') && !want.reconcile) return;
      if (s.startsWith('poly-pos:') && !want.position) return;
      if (s.startsWith('poly-act:') && !want.activity) return;
      const qty = sizeFromPolyFillId(s);
      if (qty > 0) keys.add(`:${sizeKey(qty)}`);
    });
  }
  return keys;
}

// Activity skips when reconcile, position, or a live WS row already booked
// this lock/slug + size. Other activity lots of the same size still book.
function bookedReconcileKeys({ bookedFills, seenFillIds } = {}) {
  return bookedPolySizeKeys({
    bookedFills,
    seenFillIds,
    include: { activity: false, reconcile: true, position: true, other: true },
  });
}

// Reconcile skips when activity, position, or a live WS row already booked
// this lock/slug + size.
function bookedActivityKeys({ bookedFills, seenFillIds } = {}) {
  return bookedPolySizeKeys({
    bookedFills,
    seenFillIds,
    include: { activity: true, reconcile: false, position: true, other: true },
  });
}

function alreadyBookedSameSize(trade, lock, bookedKeys) {
  if (!trade || !bookedKeys || typeof bookedKeys.has !== 'function') return false;
  const qty = sizeKey(trade.qty ?? trade.contracts ?? trade.count);
  if (!(qty > 0)) return false;
  const parlayId = (lock && lock.id) || trade.parlayId || trade.parlay_id || '';
  if (parlayId && bookedKeys.has(`${parlayId}:${qty}`)) return true;
  const slug = normalizeMarketSlug(
    trade.marketSlug || trade.marketTicker || trade.ticker || trade.market_ticker
  );
  if (slug && bookedKeys.has(`${slug}:${qty}`)) return true;
  if (parlayId && slug && bookedKeys.has(`${parlayId}:${slug}:${qty}`)) return true;
  return bookedKeys.has(`:${qty}`);
}

function bookedAnyPolyKeys({ bookedFills, seenFillIds } = {}) {
  return bookedPolySizeKeys({
    bookedFills,
    seenFillIds,
    include: { activity: true, reconcile: true, position: true, other: true },
  });
}

function activityAlreadyReconciled(trade, lock, bookedKeys) {
  return alreadyBookedSameSize(trade, lock, bookedKeys);
}

// Same lock + caoc + size already booked under a different fill_id
// (poly-act vs poly-recon). Used at persist time so a restart with an
// empty seenFillIds / stale slug cache cannot insert the 06:41 twin.
function findPolyEconomicTwin(trade, lock, bookedFills) {
  const qty = sizeKey(trade && (trade.qty ?? trade.contracts ?? trade.count));
  if (!(qty > 0)) return null;
  const parlayId = (lock && lock.id) || (trade && (trade.parlayId || trade.parlay_id)) || '';
  const slug = normalizeMarketSlug(
    trade && (trade.marketSlug || trade.marketTicker || trade.ticker || trade.market_ticker)
  );
  const selfId = fillIdOf(trade);
  for (const row of bookedFills || []) {
    if (!isPolyFillRecord(row)) continue;
    if (selfId && fillIdOf(row) === selfId) continue;
    if (sizeKey(polyFillQty(row)) !== qty) continue;
    const rowPid = parlayIdOfRecord(row);
    const rowSlug = slugOfRecord(row);
    if (parlayId && rowPid && rowPid !== parlayId) continue;
    if (slug && rowSlug && rowSlug !== slug) continue;
    if ((parlayId && rowPid === parlayId) || (slug && rowSlug === slug)) return row;
  }
  return null;
}

// Position fallback: any poly contracts already on this lock's caoc ticker.
function lockHasPolyContractsForCaoc(lock, slug, bookedFills) {
  const s = normalizeMarketSlug(slug);
  if (!isComboActivitySlug(s)) return false;
  const pid = lock && (lock.id || lock.parlayId || lock.parlay_id);
  for (const row of bookedFills || []) {
    if (!isPolyFillRecord(row)) continue;
    if (!(polyFillQty(row) > 0)) continue;
    if (slugOfRecord(row) !== s) continue;
    const rowPid = parlayIdOfRecord(row);
    if (pid && rowPid && rowPid !== pid) continue;
    return true;
  }
  return false;
}

// One-time cleanup: drop lower-rank duplicates per (parlay_id, caoc, size).
// Rank: poly-activity > poly-reconcile > other poly > poly-position.
// Position snapshots are also dropped whenever any trade row remains on
// that lock+caoc (Eagles 49.32+24.63 activity vs position 73.95).
function selectDuplicatePolyFillsToDrop(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!isPolyFillRecord(row)) continue;
    const slug = slugOfRecord(row);
    if (!isComboActivitySlug(slug)) continue;
    const key = `${parlayIdOfRecord(row) || ''}|${slug}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const drop = [];
  const seen = new Set();
  const remember = (row) => {
    const id = fillIdOf(row);
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    drop.push(row);
  };
  for (const group of groups.values()) {
    const positions = group.filter(isPositionFillRecord);
    const trades = group.filter((row) => !isPositionFillRecord(row));
    if (trades.length && positions.length) {
      for (const row of positions) remember(row);
    } else if (!trades.length && positions.length > 1) {
      for (const row of positions.slice(1)) remember(row);
    }
    const bySize = new Map();
    for (const row of trades) {
      const sk = sizeKey(polyFillQty(row));
      if (!bySize.has(sk)) bySize.set(sk, []);
      bySize.get(sk).push(row);
    }
    for (const same of bySize.values()) {
      if (same.length < 2) continue;
      const best = Math.max(...same.map(polyFillKeepRank));
      for (const row of same) {
        if (polyFillKeepRank(row) < best) remember(row);
      }
    }
  }
  return drop;
}

// Opaque caoc maker hedges: allow exact quote size or a partial below a
// posted quote. Reject trades larger than every quote (629.82 vs 43).
function slugMakerSizeAllowed(qty, quotedSizeKeys) {
  if (!quotedSizeKeys || !quotedSizeKeys.size) return true;
  const key = sizeKey(qty);
  if (!(key > 0)) return false;
  if (quotedSizeKeys.has(key)) return true;
  let maxQ = 0;
  for (const q of quotedSizeKeys) {
    if (q > maxQ) maxQ = q;
  }
  return key < maxQ;
}

function comboSlugsFromMap(slugMap, ...recordLists) {
  const slugs = new Set();
  const add = (slug) => {
    if (isComboActivitySlug(slug)) slugs.add(normalizeMarketSlug(slug));
  };
  if (slugMap && typeof slugMap.keys === 'function') {
    for (const key of slugMap.keys()) add(key);
  } else if (slugMap && typeof slugMap === 'object') {
    for (const key of Object.keys(slugMap)) add(key);
  }
  for (const records of recordLists) {
    for (const row of records || []) add(slugOfRecord(row));
  }
  return [...slugs];
}

function addQuoteId(map, quoteId, parlayId) {
  const id = quoteId || null;
  const pid = parlayId || null;
  if (!id || !pid || !map) return map;
  const prev = map.get(id);
  if (prev == null) map.set(id, pid);
  else if (prev !== pid) map.set(id, false);
  return map;
}

function quoteIdLockMap(submissions, pendingQuotes) {
  const map = new Map();
  for (const row of submissions || []) {
    addQuoteId(map, row && (row.quote_id || row.quoteId), parlayIdOfRecord(row));
  }
  if (pendingQuotes && typeof pendingQuotes.forEach === 'function') {
    pendingQuotes.forEach((pending, id) => {
      if (!pending || String(id).startsWith('reserve:')) return;
      addQuoteId(map, pending.quoteId || id, pending.parlayId || pending.parlay_id);
    });
  }
  return map;
}

function slugsByLockId(submissions, slugRecords, pendingQuotes) {
  const byLock = new Map();
  const add = (parlayId, slug) => {
    const key = normalizeMarketSlug(slug);
    if (!parlayId || !key) return;
    if (!byLock.has(parlayId)) byLock.set(parlayId, new Set());
    byLock.get(parlayId).add(key);
  };
  for (const row of [...(submissions || []), ...(slugRecords || [])]) {
    add(parlayIdOfRecord(row), slugOfRecord(row));
  }
  if (pendingQuotes && typeof pendingQuotes.forEach === 'function') {
    pendingQuotes.forEach((pending) => {
      if (!pending) return;
      add(pending.parlayId || pending.parlay_id, pending.marketTicker || pending.market_ticker || pending.symbol);
    });
  }
  return byLock;
}

function allowedSlugsFromScope(submissions, pendingQuotes) {
  const slugs = new Set();
  slugsByLockId(submissions, null, pendingQuotes).forEach((set) => {
    set.forEach((slug) => slugs.add(slug));
  });
  return slugs;
}

// A fill may book onto a lock only when its caoc ticker is that lock's mapped
// slug, or its quote_id is one of that lock's submissions. Foreign caoc
// tickers (Ravens 629.82, Eagles/Bills/Jets 24.63) never attach.
function fillBelongsToLock(evt, lock, { quoteIds, slugs } = {}) {
  if (!evt || !lock) return false;
  const ticker = normalizeMarketSlug(evt.marketTicker);
  const lockSlugs = slugs instanceof Set
    ? slugs
    : (slugs && typeof slugs.get === 'function' ? slugs.get(lock.id) : null);
  const lockQuotes = quoteIds instanceof Set
    ? quoteIds
    : (quoteIds && typeof quoteIds.has === 'function' && !(quoteIds instanceof Map)
      ? quoteIds
      : null);
  const quoteMap = quoteIds instanceof Map ? quoteIds : null;
  if (ticker && isComboActivitySlug(ticker) && lockSlugs && lockSlugs.size && !lockSlugs.has(ticker)) {
    return false;
  }
  if (evt.quoteId && lockQuotes && lockQuotes.has(evt.quoteId)) return true;
  if (evt.quoteId && quoteMap && quoteMap.get(evt.quoteId) === lock.id) return true;
  if (ticker && lockSlugs && lockSlugs.has(ticker)) return true;
  // Title-matched non-caoc trades already assigned to this lock stay.
  if (evt.parlayId === lock.id && !(ticker && isComboActivitySlug(ticker))) return true;
  return false;
}

function lockForFillEvent(evt, locks, {
  submissions,
  slugRecords,
  pendingQuotes,
  slugMap,
} = {}) {
  if (!evt) return null;
  const list = Array.isArray(locks) ? locks : [];
  const byId = new Map(list.filter((p) => p && p.id).map((p) => [p.id, p]));
  const quotes = quoteIdLockMap(submissions, pendingQuotes);
  const slugs = slugsByLockId(submissions, slugRecords, pendingQuotes);
  const map = slugMap instanceof Map || (slugMap && typeof slugMap === 'object')
    ? coerceSlugMap(slugMap)
    : buildActivitySlugMap({ submissions, slugRecords });

  const candidates = [];
  const pendingId = evt.parlayId || (evt.pending && evt.pending.parlayId) || null;
  if (pendingId && byId.has(pendingId)) candidates.push(byId.get(pendingId));
  const qLock = evt.quoteId ? quotes.get(evt.quoteId) : null;
  if (qLock && qLock !== false && byId.has(qLock)) candidates.push(byId.get(qLock));
  const ticker = normalizeMarketSlug(evt.marketTicker);
  const mapped = ticker ? (map.get(ticker) || map[ticker]) : null;
  if (mapped && mapped !== false && byId.has(mapped)) candidates.push(byId.get(mapped));

  const seen = new Set();
  for (const lock of candidates) {
    if (!lock || seen.has(lock.id)) continue;
    seen.add(lock.id);
    if (fillBelongsToLock(evt, lock, { quoteIds: quotes, slugs })) return lock;
  }
  if (list.length === 1) {
    const only = list[0];
    if (fillBelongsToLock(evt, only, { quoteIds: quotes, slugs })) return only;
  }
  return null;
}

function quoteCandidateInLockScope(c, allowedQuoteIds, allowedSlugs) {
  if (!c) return false;
  const ticker = normalizeMarketSlug(symbolOf(c.quote) || (c.pending && (
    c.pending.marketTicker || c.pending.market_ticker || c.pending.symbol
  )));
  if (ticker && isComboActivitySlug(ticker) && allowedSlugs && allowedSlugs.size && !allowedSlugs.has(ticker)) {
    return false;
  }
  if (c.pending && c.pending.parlayId) return true;
  if (c.id && allowedQuoteIds && allowedQuoteIds.has(c.id)) return true;
  if (ticker && allowedSlugs && allowedSlugs.has(ticker)) return true;
  return false;
}

function scopeQuoteCandidates(candidates, { submissions, pendingQuotes } = {}) {
  const quotes = quoteIdLockMap(submissions, pendingQuotes);
  const slugs = allowedSlugsFromScope(submissions, pendingQuotes);
  const scoped = !!(quotes.size || slugs.size);
  if (!scoped) {
    return (candidates || []).filter((c) => c && c.pending && c.pending.parlayId);
  }
  return (candidates || []).filter((c) => quoteCandidateInLockScope(c, quotes, slugs));
}

function reconcileFillId(quoteId, orderId, cumQty) {
  const cum = parsePositive(cumQty);
  if (quoteId && cum) return `poly-recon:${quoteId}:${cum}`;
  if (orderId && cum) return `poly-recon:${orderId}:${cum}`;
  return `poly-recon:${quoteId || orderId || 'unknown'}`;
}

function quotesFromListed(listed) {
  if (!listed || typeof listed !== 'object') return [];
  const rows = listed.quotes || listed.data;
  return Array.isArray(rows) ? rows.filter((q) => q && typeof q === 'object') : [];
}

function activitiesFromListed(listed) {
  if (!listed || typeof listed !== 'object') return [];
  const rows = listed.activities || listed.data;
  return Array.isArray(rows) ? rows.filter((a) => a && typeof a === 'object') : [];
}

function positionsFromListed(listed) {
  if (!listed || typeof listed !== 'object') return [];
  if (Array.isArray(listed.positions)) return listed.positions.filter((p) => p && typeof p === 'object');
  if (listed.positions && typeof listed.positions === 'object') {
    return Object.entries(listed.positions).map(([slug, pos]) => {
      if (!pos || typeof pos !== 'object') return null;
      const meta = pos.marketMetadata || pos.market_metadata || {};
      return { ...pos, marketSlug: pos.marketSlug || pos.market_slug || meta.slug || slug };
    }).filter(Boolean);
  }
  return [];
}

function pendingFromSubmission(row) {
  if (!row) return null;
  return {
    parlayId: row.parlay_id || row.parlayId || null,
    userId: row.user_id || row.userId || null,
    contracts: parsePositive(row.contracts),
    label: row.label || null,
    rfqId: row.rfq_id || row.rfqId || null,
    quoteId: row.quote_id || row.quoteId || null,
    marketTicker: row.market_ticker || row.marketTicker || row.symbol || null,
    maxContracts: row.max_contracts != null ? Number(row.max_contracts) : null,
    alreadyFilled: String(row.status || '').toLowerCase() === 'filled',
  };
}

function fillEventFromReconcile({
  quote,
  order,
  pending,
  pendingId,
  alreadyFilled = 0,
  allowExecutedWithoutOrder = false,
  source = 'poly-reconcile',
} = {}) {
  const quoteId = quoteIdOf(quote) || pendingId || (pending && (pending.quoteId || pending.quote_id)) || null;
  const orderId = (order && (order.id || order.orderId || order.order_id))
    || orderIdOfQuote(quote)
    || (pending && (pending.creatorOrderId || pending.orderId || pending.order_id))
    || null;
  const sized = quotedContractsForReconcile(quote, pending);
  if (sized.mismatch) return null;
  const quoted = sized.quoted;
  let cum = cumQuantityOf(order);
  if (!(cum > 0) && allowExecutedWithoutOrder && isExecutedQuoteStatus(quote && quote.status) && quoted > 0) {
    cum = quoted;
  }
  const state = orderStateOf(order);
  if (cum > 0 && quoted > 0 && !orderQtyMatchesQuoted(cum, quoted, state)) return null;
  const contracts = incrementFromCum(cum, alreadyFilled);
  if (!(contracts > 0) || (!quoteId && !orderId)) return null;
  return {
    quoteId,
    orderId: orderId || null,
    fillId: reconcileFillId(quoteId, orderId, cum),
    contracts,
    venue: 'polymarket',
    isPartial: isPartialOrderState(state) || (quoted > 0 && cum + 1e-9 < quoted),
    rfqId: rfqIdOf(quote) || (pending && pending.rfqId) || null,
    marketTicker: symbolOf(quote) || (order && (order.marketSlug || order.market_slug)) || null,
    label: (pending && pending.label) || null,
    parlayId: pending && pending.parlayId,
    source,
    pending: pending
      ? {
        parlayId: pending.parlayId,
        userId: pending.userId,
        contracts: pending.contracts,
        label: pending.label,
        rfqId: pending.rfqId,
        maxContracts: pending.maxContracts,
      }
      : null,
  };
}

function significantLockTokens(label) {
  return String(label || '')
    .toUpperCase()
    .replace(/[^A-Z0-9+\s]/g, ' ')
    .split(/[\s+]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !/^(PLUS|WITH|FROM|THAT|THIS|OVER|UNDER|MONEY|LINE)$/.test(w));
}

// "Cleveland Guardians ML + New York Yankees ML + San Francisco Giants ML"
// → GUARDIANS, YANKEES, GIANTS. Combo cards often omit the city.
function lockTeamNicknames(label) {
  return String(label || '')
    .split(/\s*\+\s*/)
    .map((part) => {
      const words = String(part || '').replace(/\bM[Ll]\b/g, '').trim().split(/\s+/);
      return String(words[words.length - 1] || '').toUpperCase().replace(/[^A-Z]/g, '');
    })
    .filter((w) => w.length >= 3);
}

function lockLabelMatchesMarket(label, title, slug) {
  const hay = `${title || ''} ${slug || ''}`.toUpperCase();
  if (!hay.trim()) return false;
  const nicknames = lockTeamNicknames(label);
  if (nicknames.length >= 2 && nicknames.every((t) => hay.includes(t))) return true;
  const tokens = significantLockTokens(label);
  if (tokens.length < 2) return false;
  return tokens.every((t) => hay.includes(t));
}

function normalizeMarketSlug(slug) {
  const s = String(slug == null ? '' : slug).trim().toLowerCase();
  return s || null;
}

function isComboActivitySlug(slug) {
  const s = normalizeMarketSlug(slug);
  return !!(s && s.startsWith('caoc-'));
}

function slugOfRecord(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  return normalizeMarketSlug(
    row.marketSlug || row.market_slug || row.market_ticker || row.marketTicker
    || row.ticker || row.symbol
    || raw.market_ticker || raw.marketTicker || raw.symbol || raw.marketSlug
  );
}

function parlayIdOfRecord(row) {
  return (row && (row.parlay_id || row.parlayId)) || null;
}

function coerceSlugMap(input) {
  if (input instanceof Map) return new Map(input);
  const map = new Map();
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) rememberSlug(map, key, value);
  }
  return map;
}

function rememberSlug(map, slug, parlayId) {
  const key = normalizeMarketSlug(slug);
  const id = parlayId || null;
  if (!key || !id || !map) return map;
  const prev = map.get(key);
  if (prev == null) map.set(key, id);
  else if (prev !== id) map.set(key, false);
  return map;
}

function slugMapFromRecords(records, map) {
  const out = map instanceof Map ? map : new Map();
  for (const row of records || []) {
    rememberSlug(out, slugOfRecord(row), parlayIdOfRecord(row));
  }
  return out;
}

function slugMapFromQuotes(quotes, submissions, map) {
  const out = map instanceof Map ? map : new Map();
  const byQuote = new Map();
  for (const row of submissions || []) {
    const quoteId = row && (row.quote_id || row.quoteId);
    const parlayId = parlayIdOfRecord(row);
    if (quoteId && parlayId) {
      const prev = byQuote.get(quoteId);
      if (prev == null) byQuote.set(quoteId, parlayId);
      else if (prev !== parlayId) byQuote.set(quoteId, false);
    }
    rememberSlug(out, slugOfRecord(row), parlayId);
  }
  for (const quote of quotes || []) {
    const quoteId = quoteIdOf(quote);
    const mapped = quoteId ? byQuote.get(quoteId) : null;
    const parlayId = mapped || parlayIdOfRecord(quote);
    if (parlayId) rememberSlug(out, symbolOf(quote) || slugOfRecord(quote), parlayId);
  }
  return out;
}

function buildActivitySlugMap({ slugMap, slugRecords, quotes, submissions } = {}) {
  const map = coerceSlugMap(slugMap);
  slugMapFromRecords(slugRecords, map);
  slugMapFromQuotes(quotes, [...(submissions || []), ...(slugRecords || [])], map);
  return map;
}

function lockForMappedSlug(locks, slug, slugMap) {
  const key = normalizeMarketSlug(slug);
  if (!key || !slugMap) return null;
  const id = slugMap instanceof Map ? slugMap.get(key) : slugMap[key];
  if (!id) return null;
  return (locks || []).find((p) => p && p.id === id) || null;
}

function uniqueLockForMarket(locks, title, slug, slugMap) {
  return lockMatchForActivity(locks, title, slug, slugMap).lock;
}

function lockMatchForActivity(locks, title, slug, slugMap) {
  const mapped = lockForMappedSlug(locks, slug, slugMap);
  const titleHits = (locks || []).filter((p) => p && lockLabelMatchesMarket(p.label, title, slug));
  const titled = titleHits.length === 1 ? titleHits[0] : null;
  if (mapped) {
    return { lock: mapped, via: titled && titled.id === mapped.id ? 'both' : 'slug' };
  }
  if (titled) return { lock: titled, via: 'title' };
  return { lock: null, via: null };
}

function activityTypeLooksFill(type) {
  const s = normalizeStatus(type);
  return s.includes('TRADE') || s.includes('SETTLE') || s.includes('REDEEM')
    || s.includes('CASH') || s.includes('SOLD') || s.includes('PAYOUT')
    || s.includes('POSITION');
}

function collectMarketParts(node, out) {
  if (!node) return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectMarketParts(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  for (const key of ['title', 'name', 'slug', 'marketSlug', 'market_slug', 'symbol', 'question']) {
    if (node[key]) out.push(String(node[key]));
  }
  const meta = node.marketMetadata || node.market_metadata;
  if (meta && meta !== node) collectMarketParts(meta, out);
  for (const key of ['markets', 'legs', 'outcomes', 'games', 'events']) {
    if (node[key]) collectMarketParts(node[key], out);
  }
}

function activityMarketHay(activity, trade) {
  const parts = [];
  collectMarketParts(activity, parts);
  collectMarketParts(trade, parts);
  return parts.join(' ');
}

function tradeFromActivity(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const type = normalizeStatus(activity.type);
  const trade = activity.trade || activity.order
    || (activityTypeLooksFill(type) ? activity : null);
  if (!trade || typeof trade !== 'object') return null;
  if (trade.state && normalizeStatus(trade.state) === 'TRADE_STATE_BUSTED') return null;
  const qty = firstPositiveAmount(
    trade.qtyDecimal, trade.qty_decimal, trade.qty, trade.size,
    trade.payout, activity.payout,
    trade.cashPayout || trade.cash_payout,
    trade.cost, activity.cost,
    trade.costBasis || trade.cost_basis
  );
  if (!(qty > 0)) return null;
  const meta = trade.marketMetadata || trade.market_metadata
    || activity.marketMetadata || activity.market_metadata || {};
  const hay = activityMarketHay(activity, trade);
  return {
    id: trade.id || activity.id || null,
    marketSlug: trade.marketSlug || trade.market_slug || meta.slug || null,
    title: meta.title || trade.title || activity.title || hay || null,
    hay,
    qty,
    price: amountValue(trade.price),
    cost: amountValue(trade.costBasis || trade.cost_basis)
      || amountValue(trade.cost) || amountValue(activity.cost)
      || (amountValue(trade.price) * qty),
    isAggressor: !!(trade.isAggressor || trade.is_aggressor || /SOLD|CASH/.test(type)),
    createTime: trade.createTime || trade.create_time || activity.createTime || null,
  };
}

function absQty(v) {
  const n = parseFloat(typeof v === 'object' && v != null ? v.value : v);
  if (!Number.isFinite(n) || n === 0) return 0;
  return parsePositive(Math.abs(n));
}

// Open Combo Lock hedges are No / short Yes. qtyBoughtDecimal is often "0"
// (?? would stop there) and netPositionDecimal is negative.
function positionQty(pos) {
  if (!pos || typeof pos !== 'object') return 0;
  if (
    pos.netPositionDecimal != null || pos.net_position_decimal != null
    || pos.netPosition != null
  ) {
    return absQty(pos.netPositionDecimal ?? pos.net_position_decimal ?? pos.netPosition);
  }
  return firstPositiveAmount(
    pos.qtyAvailableDecimal, pos.qty_available_decimal,
    pos.qtyBoughtDecimal, pos.qty_bought_decimal,
    pos.qtySoldDecimal, pos.qty_sold_decimal,
    pos.qtyBought, pos.qtySold
  );
}

function positionCost(pos) {
  return amountValue(pos && pos.cost);
}

async function listSelfExecutedQuotes(http, { limit = 100, cursor } = {}) {
  if (!http || typeof http.listQuotes !== 'function') return { quotes: [], cursor: null };
  const listed = await http.listQuotes({
    status: QUOTE_STATUS_EXECUTED,
    userFilter: USER_FILTER_SELF,
    limit,
    cursor,
  });
  return {
    quotes: quotesFromListed(listed),
    cursor: listed && (listed.cursor || listed.nextCursor || listed.next_cursor) || null,
  };
}

async function fetchQuoteByIds(http, { rfqId, quoteId } = {}) {
  if (!http || typeof http.listQuotes !== 'function' || !rfqId || !quoteId) return null;
  try {
    const listed = await http.listQuotes({ rfqId, quoteId });
    const rows = quotesFromListed(listed);
    return rows.find((q) => quoteIdOf(q) === quoteId) || rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function fetchOrder(http, orderId) {
  if (!http || !orderId) return null;
  if (typeof http.getOrder === 'function') {
    try { return orderFromResponse(await http.getOrder(orderId)) || null; } catch (_) { return null; }
  }
  if (typeof http.request !== 'function') return null;
  try {
    const res = await http.request('GET', `/v1/order/${encodeURIComponent(orderId)}`);
    if (!res || res.statusCode === 404) return null;
    if (!(res.statusCode < 400)) return null;
    return orderFromResponse(res.json);
  } catch (_) {
    return null;
  }
}

async function resolveQuoteFill(http, {
  quote,
  pending,
  pendingId,
  alreadyFilled = 0,
  allowExecutedWithoutOrder = false,
} = {}) {
  if (!quote && !pending) return null;
  const q = quote || {};
  const orderId = orderIdOfQuote(q)
    || (pending && (pending.creatorOrderId || pending.orderId || pending.order_id))
    || null;
  const order = orderId ? await fetchOrder(http, orderId) : null;
  if (order && !(cumQuantityOf(order) > 0) && !isFilledOrderState(order.state)) {
    return null;
  }
  return fillEventFromReconcile({
    quote: q,
    order,
    pending,
    pendingId: pendingId || quoteIdOf(q),
    alreadyFilled,
    allowExecutedWithoutOrder: allowExecutedWithoutOrder && !order,
  });
}

function mergeQuoteRecord(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const orderId = orderIdOfQuote(a) || orderIdOfQuote(b);
  const executed = isExecutedQuoteStatus(a.status) || isExecutedQuoteStatus(b.status);
  return {
    ...a,
    ...b,
    id: quoteIdOf(a) || quoteIdOf(b),
    rfqId: rfqIdOf(a) || rfqIdOf(b),
    status: executed ? QUOTE_STATUS_EXECUTED : (b.status || a.status || null),
    creatorOrderId: orderId,
    creator_order_id: orderId,
    buyQtyDecimal: contractsFromQuote(a) || contractsFromQuote(b) || a.buyQtyDecimal || b.buyQtyDecimal,
  };
}

function mergeQuoteCandidates(executedQuotes, submissions, pendingQuotes) {
  const byId = new Map();
  const remember = (quote, pending) => {
    const id = quoteIdOf(quote) || (pending && (pending.quoteId || pending.quote_id));
    if (!id) return;
    const prev = byId.get(id) || { quote: null, pending: null };
    byId.set(id, {
      quote: mergeQuoteRecord(prev.quote, quote),
      pending: pending || prev.pending,
    });
  };
  for (const q of executedQuotes || []) remember(q, null);
  for (const row of submissions || []) {
    remember({
      id: row.quote_id || row.quoteId,
      rfqId: row.rfq_id || row.rfqId,
      creatorOrderId: row.order_id || row.orderId || null,
      buyQtyDecimal: row.contracts,
      symbol: row.market_ticker || row.marketTicker || row.symbol || null,
    }, pendingFromSubmission(row));
  }
  if (pendingQuotes && typeof pendingQuotes.forEach === 'function') {
    pendingQuotes.forEach((pending, id) => {
      if (!pending || String(id).startsWith('reserve:')) return;
      remember({
        id,
        rfqId: pending.rfqId,
        creatorOrderId: pending.creatorOrderId || pending.orderId || null,
        buyQtyDecimal: pending.contracts,
        status: pending.executed ? QUOTE_STATUS_EXECUTED : null,
        symbol: pending.marketTicker || pending.market_ticker || pending.symbol || null,
      }, { ...pending, quoteId: pending.quoteId || id });
    });
  }
  return [...byId.entries()].map(([id, v]) => ({ id, ...v }));
}

async function hydrateMissingQuotes(http, candidates, maxHydrate) {
  let n = 0;
  for (const c of candidates) {
    if (n >= maxHydrate) break;
    if (c.quote && isExecutedQuoteStatus(c.quote.status) && orderIdOfQuote(c.quote)) continue;
    const rfqId = rfqIdOf(c.quote) || (c.pending && c.pending.rfqId);
    const quoteId = quoteIdOf(c.quote) || c.id;
    if (!rfqId || !quoteId) continue;
    if (c.quote && isExecutedQuoteStatus(c.quote.status)) continue;
    const got = await fetchQuoteByIds(http, { rfqId, quoteId });
    n += 1;
    if (got) c.quote = { ...(c.quote || {}), ...got };
  }
  return n;
}

function pickReconcileCandidates(candidates, { maxPerTick = DEFAULT_MAX_PER_TICK, seenQuoteIds } = {}) {
  const seen = seenQuoteIds && typeof seenQuoteIds.has === 'function' ? seenQuoteIds : new Set();
  const ranked = [];
  for (const c of candidates || []) {
    if (!c || !c.id || seen.has(c.id)) continue;
    const executed = isExecutedQuoteStatus(c.quote && c.quote.status);
    const hasOrder = !!(orderIdOfQuote(c.quote) || (c.pending && (c.pending.creatorOrderId || c.pending.orderId)));
    ranked.push({ c, score: (executed ? 2 : 0) + (hasOrder ? 1 : 0) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxPerTick).map((x) => x.c);
}

async function reconcilePolymarketLockFills(http, {
  pendingQuotes,
  submissions = [],
  alreadyFilledByQuote = {},
  getFilledForQuote,
  allowExecutedWithoutOrder = false,
  maxPerTick = DEFAULT_MAX_PER_TICK,
  seenQuoteIds,
  seenFillIds,
  bookedFills,
  hydrate = true,
} = {}) {
  let executed = [];
  try {
    const listed = await listSelfExecutedQuotes(http, { limit: 100 });
    executed = listed.quotes || [];
  } catch (_) {
    executed = [];
  }
  const candidates = scopeQuoteCandidates(
    mergeQuoteCandidates(executed, submissions, pendingQuotes),
    { submissions, pendingQuotes }
  );
  if (hydrate) await hydrateMissingQuotes(http, candidates, maxPerTick);
  const picked = pickReconcileCandidates(candidates, { maxPerTick, seenQuoteIds });
  const quoteIds = quoteIdLockMap(submissions, pendingQuotes);
  const slugs = slugsByLockId(submissions, null, pendingQuotes);
  const events = [];
  for (const c of picked) {
    const quoteId = c.id;
    let already = parsePositive(alreadyFilledByQuote[quoteId]);
    if (!(already > 0) && typeof getFilledForQuote === 'function') {
      try { already = parsePositive(await getFilledForQuote(quoteId)); } catch (_) { already = 0; }
    }
    const evt = await resolveQuoteFill(http, {
      quote: c.quote,
      pending: c.pending,
      pendingId: quoteId,
      alreadyFilled: already,
      allowExecutedWithoutOrder,
    });
    if (evt && evt.contracts > 0) {
      const lockId = (c.pending && c.pending.parlayId) || quoteIds.get(quoteId);
      const lock = lockId && lockId !== false ? { id: lockId } : { id: evt.parlayId };
      if (alreadyBookedSameSize(evt, lock, bookedActivityKeys({ bookedFills, seenFillIds }))) {
        if (seenQuoteIds && quoteId) seenQuoteIds.add(quoteId);
        continue;
      }
      if (lockId && lockId !== false) {
        if (!fillBelongsToLock(evt, { id: lockId }, { quoteIds, slugs })) continue;
        if (!evt.parlayId) evt.parlayId = lockId;
      } else if (evt.marketTicker && isComboActivitySlug(evt.marketTicker)) {
        const allowed = allowedSlugsFromScope(submissions, pendingQuotes);
        if (allowed.size && !allowed.has(normalizeMarketSlug(evt.marketTicker))) continue;
      } else if (!c.pending) {
        continue;
      }
      events.push(evt);
    }
    else if (seenQuoteIds && c.quote && isExecutedQuoteStatus(c.quote.status) && already > 0) {
      seenQuoteIds.add(quoteId);
    }
  }
  return events;
}

function activityFillEvent({ trade, lock, source }) {
  if (!trade || !lock || !(trade.qty > 0)) return null;
  const fillId = trade.id ? `poly-act:${trade.id}` : `poly-act:${lock.id}:${trade.qty}`;
  const kind = source || (trade.isAggressor ? 'poly-activity-sold' : 'poly-activity');
  return {
    quoteId: null,
    orderId: trade.id || null,
    fillId,
    contracts: trade.qty,
    venue: 'polymarket',
    isPartial: false,
    rfqId: null,
    marketTicker: trade.marketSlug || null,
    label: lock.label || null,
    parlayId: lock.id,
    source: kind,
    pending: {
      parlayId: lock.id,
      userId: lock.user_id || lock.userId || null,
      contracts: trade.qty,
      label: lock.label || null,
      rfqId: null,
      maxContracts: lock.max_contracts != null ? Number(lock.max_contracts) : null,
    },
  };
}

function matchActivitiesToLocks(activities, locks, {
  requireMaker = false,
  seenFillIds,
  slugMap,
  bookedFills,
  quotedByLock,
} = {}) {
  const events = [];
  const matchedLockIds = new Set();
  const booked = seenFillIds && typeof seenFillIds.has === 'function' ? seenFillIds : null;
  const local = new Set();
  const map = slugMap instanceof Map || (slugMap && typeof slugMap === 'object')
    ? coerceSlugMap(slugMap)
    : null;
  const bookedKeys = bookedAnyPolyKeys({ bookedFills, seenFillIds });
  const quoteSizes = quotedByLock instanceof Map
    ? quotedByLock
    : quotedSizesByLock(quotedByLock);
  for (const activity of activities || []) {
    const trade = tradeFromActivity(activity);
    if (!trade) continue;
    if (requireMaker && trade.isAggressor) continue;
    const hit = lockMatchForActivity(locks, trade.hay || trade.title, trade.marketSlug, map);
    const lock = hit.lock;
    if (!lock) continue;
    if (activityAlreadyReconciled(trade, lock, bookedKeys)) {
      matchedLockIds.add(lock.id);
      continue;
    }
    // Opaque caoc maker hedges: exact quote or partial below a quote.
    // Oversized (629.82 vs 43) is a different trade — do not invent, and
    // do not mark the lock covered so positions can still recover the hedge.
    if (!trade.isAggressor && hit.via === 'slug') {
      const sizes = quoteSizes && quoteSizes.get(lock.id);
      if (!slugMakerSizeAllowed(trade.qty, sizes)) continue;
    }
    const evt = activityFillEvent({ trade, lock });
    if (!evt) continue;
    if (local.has(evt.fillId) || (booked && booked.has(evt.fillId))) {
      matchedLockIds.add(lock.id);
      continue;
    }
    local.add(evt.fillId);
    matchedLockIds.add(lock.id);
    events.push(evt);
  }
  events.matchedLockIds = matchedLockIds;
  return events;
}

async function listActivitiesPage(http, { limit = 100, maxPages = 8, marketSlug } = {}) {
  if (!http || typeof http.listActivities !== 'function') return [];
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const listed = await http.listActivities({
      types: 'ACTIVITY_TYPE_TRADE',
      limit,
      cursor,
      sortOrder: 'SORT_ORDER_DESCENDING',
      ...(marketSlug ? { marketSlug } : {}),
    });
    const rows = activitiesFromListed(listed);
    out.push(...rows);
    cursor = listed && (listed.nextCursor || listed.next_cursor || listed.cursor) || null;
    if (!cursor || (listed && listed.eof) || !rows.length) break;
  }
  return out;
}

async function listAllActivities(http, opts) {
  return listActivitiesPage(http, opts);
}

function activityDedupeKey(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const trade = activity.trade || activity.order;
  return (trade && (trade.id || trade.tradeId)) || activity.id || null;
}

function mergeActivities(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const activity of list || []) {
      const key = activityDedupeKey(activity);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(activity);
    }
  }
  return out;
}

async function listActivitiesForMarketSlugs(http, slugs, { limit = 100, maxPages = 4 } = {}) {
  const out = [];
  for (const slug of slugs || []) {
    const key = normalizeMarketSlug(slug);
    if (!isComboActivitySlug(key)) continue;
    try {
      const rows = await listActivitiesPage(http, { limit, maxPages, marketSlug: key });
      out.push(...rows);
    } catch (_) { /* keep other slugs */ }
  }
  return out;
}

async function reconcileLockActivityEvents(http, {
  locks = [],
  seenFillIds,
  includePositions = true,
  maxPages = 8,
  slugMap,
  slugRecords,
  submissions,
  quotes,
  bookedFills,
  pendingQuotes,
} = {}) {
  if (!locks.length) return [];
  const map = buildActivitySlugMap({ slugMap, slugRecords, quotes, submissions });
  const quotedByLock = quotedSizesByLock(
    [...(submissions || []), ...(slugRecords || [])],
    pendingQuotes
  );
  const booked = [...(bookedFills || []), ...(slugRecords || [])];
  if (!quotes && http && typeof http.listQuotes === 'function') {
    try {
      const listed = await listSelfExecutedQuotes(http, { limit: 100 });
      slugMapFromQuotes(listed.quotes, [...(submissions || []), ...(slugRecords || [])], map);
    } catch (_) { /* slug map stays at records / explicit map */ }
  }
  let activities = [];
  try {
    activities = await listAllActivities(http, { maxPages });
  } catch (_) {
    activities = [];
  }
  const slugs = comboSlugsFromMap(map, submissions, slugRecords, quotes);
  if (slugs.length) {
    try {
      activities = mergeActivities(
        activities,
        await listActivitiesForMarketSlugs(http, slugs)
      );
    } catch (_) { /* global page still used */ }
  }
  const events = matchActivitiesToLocks(activities, locks, {
    seenFillIds,
    slugMap: map,
    bookedFills: booked,
    quotedByLock,
  });
  const covered = new Set([
    ...events.map((e) => e.parlayId).filter(Boolean),
    ...(events.matchedLockIds || []),
  ]);
  for (const lock of locks) {
    if (!lock || !lock.id || covered.has(lock.id)) continue;
    const already = booked.some((row) => (
      isPolyFillRecord(row)
      && parlayIdOfRecord(row) === lock.id
      && isComboActivitySlug(slugOfRecord(row))
      && polyFillQty(row) > 0
    ));
    if (already) covered.add(lock.id);
  }
  if (!includePositions || typeof http.listPositions !== 'function') return events;
  const uncovered = locks.filter((p) => p && p.id && !covered.has(p.id));
  if (!uncovered.length) return events;
  try {
    const listed = await http.listPositions({ limit: 100 });
    return events.concat(matchPositionsToLocks(positionsFromListed(listed), uncovered, {
      seenFillIds,
      slugMap: map,
      bookedFills: booked,
    }));
  } catch (_) {
    return events;
  }
}

function positionFillEvent({ pos, lock, source = 'poly-position' }) {
  const qty = positionQty(pos);
  if (!lock || !(qty > 0)) return null;
  const slug = pos.marketSlug || (pos.marketMetadata && pos.marketMetadata.slug) || 'pos';
  return {
    quoteId: null,
    orderId: null,
    fillId: `poly-pos:${lock.id}:${slug}:${qty}`,
    contracts: qty,
    venue: 'polymarket',
    isPartial: false,
    rfqId: null,
    marketTicker: slug,
    label: lock.label || null,
    parlayId: lock.id,
    source,
    pending: {
      parlayId: lock.id,
      userId: lock.user_id || lock.userId || null,
      contracts: qty,
      label: lock.label || null,
      rfqId: null,
      maxContracts: lock.max_contracts != null ? Number(lock.max_contracts) : null,
    },
  };
}

function matchPositionsToLocks(positions, locks, { seenFillIds, slugMap, bookedFills } = {}) {
  const events = [];
  const booked = seenFillIds && typeof seenFillIds.has === 'function' ? seenFillIds : null;
  const local = new Set();
  const map = slugMap instanceof Map || (slugMap && typeof slugMap === 'object')
    ? coerceSlugMap(slugMap)
    : null;
  for (const pos of positions || []) {
    const meta = (pos && pos.marketMetadata) || {};
    const title = meta.title || pos.title || '';
    const slug = pos.marketSlug || meta.slug || '';
    const hay = activityMarketHay(pos, { marketMetadata: meta, marketSlug: slug, title });
    const lock = uniqueLockForMarket(locks, hay || title, slug, map);
    if (!lock) continue;
    if (lockHasPolyContractsForCaoc(lock, slug, bookedFills)) continue;
    const evt = positionFillEvent({ pos, lock });
    if (!evt || local.has(evt.fillId) || (booked && booked.has(evt.fillId))) continue;
    local.add(evt.fillId);
    events.push(evt);
  }
  return events;
}

module.exports = {
  USER_FILTER_SELF,
  QUOTE_STATUS_EXECUTED,
  parsePositive,
  amountValue,
  quoteIdOf,
  rfqIdOf,
  orderIdOfQuote,
  isExecutedQuoteStatus,
  orderFromResponse,
  orderStateOf,
  isFilledOrderState,
  isPartialOrderState,
  cumQuantityOf,
  contractsFromQuote,
  firstPositiveAmount,
  incrementFromCum,
  sizesEqual,
  sizeKey,
  quotedContractsForReconcile,
  orderQtyMatchesQuoted,
  isReconcileFillRecord,
  isActivityFillRecord,
  isPositionFillRecord,
  isPolyFillRecord,
  polyFillQty,
  polyFillKeepRank,
  reconcileSizeFromFillId,
  quotedSizesByLock,
  bookedPolySizeKeys,
  bookedReconcileKeys,
  bookedActivityKeys,
  bookedAnyPolyKeys,
  alreadyBookedSameSize,
  activityAlreadyReconciled,
  findPolyEconomicTwin,
  lockHasPolyContractsForCaoc,
  selectDuplicatePolyFillsToDrop,
  slugMakerSizeAllowed,
  comboSlugsFromMap,
  quoteIdLockMap,
  slugsByLockId,
  fillBelongsToLock,
  lockForFillEvent,
  scopeQuoteCandidates,
  reconcileFillId,
  quotesFromListed,
  activitiesFromListed,
  positionsFromListed,
  pendingFromSubmission,
  fillEventFromReconcile,
  lockLabelMatchesMarket,
  normalizeMarketSlug,
  isComboActivitySlug,
  slugOfRecord,
  rememberSlug,
  slugMapFromRecords,
  slugMapFromQuotes,
  buildActivitySlugMap,
  uniqueLockForMarket,
  lockMatchForActivity,
  tradeFromActivity,
  activityMarketHay,
  activityFillEvent,
  matchActivitiesToLocks,
  listAllActivities,
  listActivitiesForMarketSlugs,
  mergeActivities,
  reconcileLockActivityEvents,
  lockTeamNicknames,
  positionQty,
  absQty,
  positionCost,
  positionFillEvent,
  matchPositionsToLocks,
  listSelfExecutedQuotes,
  fetchQuoteByIds,
  fetchOrder,
  resolveQuoteFill,
  mergeQuoteCandidates,
  pickReconcileCandidates,
  reconcilePolymarketLockFills,
};
