// Durable Polymarket Combo Lock fill recovery.
//
// Live WS orderExecution is the fast path. It is not sufficient:
// quoteExecuted only means paired orders were submitted, ORDER fills can
// arrive after polyPendingQuotes TTL, and Retail docs say to reconcile
// fills via GetQuotes + the order snapshot (Drop Copy / GET /v1/order).
// This module turns those durable reads into the same onQuoteExecuted
// events live-runner already persists (combo_fills + filled submissions
// + Telegram).
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

function incrementFromCum(cumQty, alreadyFilled) {
  const cum = parsePositive(cumQty);
  const have = parsePositive(alreadyFilled);
  if (!(cum > 0)) return 0;
  const inc = Math.round((cum - have) * 1e8) / 1e8;
  return inc > 1e-9 ? inc : 0;
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
  const quoted = contractsFromQuote(quote) || (pending && pending.contracts) || 0;
  let cum = cumQuantityOf(order);
  if (!(cum > 0) && allowExecutedWithoutOrder && isExecutedQuoteStatus(quote && quote.status) && quoted > 0) {
    cum = quoted;
  }
  const contracts = incrementFromCum(cum, alreadyFilled);
  if (!(contracts > 0) || (!quoteId && !orderId)) return null;
  const state = orderStateOf(order);
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

function lockLabelMatchesMarket(label, title, slug) {
  const tokens = significantLockTokens(label);
  if (tokens.length < 2) return false;
  const hay = `${title || ''} ${slug || ''}`.toUpperCase();
  if (!hay.trim()) return false;
  return tokens.every((t) => hay.includes(t));
}

function uniqueLockForMarket(locks, title, slug) {
  const hits = (locks || []).filter((p) => p && lockLabelMatchesMarket(p.label, title, slug));
  if (hits.length !== 1) return null;
  return hits[0];
}

function tradeFromActivity(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const trade = activity.trade || (normalizeStatus(activity.type).includes('TRADE') ? activity : null);
  if (!trade || typeof trade !== 'object') return null;
  if (trade.state && normalizeStatus(trade.state) === 'TRADE_STATE_BUSTED') return null;
  const qty = parsePositive(trade.qtyDecimal ?? trade.qty_decimal ?? trade.qty);
  if (!(qty > 0)) return null;
  return {
    id: trade.id || activity.id || null,
    marketSlug: trade.marketSlug || trade.market_slug || null,
    qty,
    price: amountValue(trade.price),
    cost: amountValue(trade.costBasis || trade.cost_basis) || (amountValue(trade.price) * qty),
    isAggressor: !!(trade.isAggressor || trade.is_aggressor),
    createTime: trade.createTime || trade.create_time || null,
  };
}

function positionQty(pos) {
  if (!pos || typeof pos !== 'object') return 0;
  return parsePositive(
    pos.qtyBoughtDecimal ?? pos.qty_bought_decimal ?? pos.netPositionDecimal
    ?? pos.net_position_decimal ?? pos.qtyBought ?? pos.netPosition
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
  hydrate = true,
} = {}) {
  let executed = [];
  try {
    const listed = await listSelfExecutedQuotes(http, { limit: 100 });
    executed = listed.quotes || [];
  } catch (_) {
    executed = [];
  }
  const candidates = mergeQuoteCandidates(executed, submissions, pendingQuotes);
  if (hydrate) await hydrateMissingQuotes(http, candidates, maxPerTick);
  const picked = pickReconcileCandidates(candidates, { maxPerTick, seenQuoteIds });
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
    if (evt && evt.contracts > 0) events.push(evt);
    else if (seenQuoteIds && c.quote && isExecutedQuoteStatus(c.quote.status) && already > 0) {
      seenQuoteIds.add(quoteId);
    }
  }
  return events;
}

function activityFillEvent({ trade, lock, source = 'poly-activity' }) {
  if (!trade || !lock || !(trade.qty > 0)) return null;
  const fillId = trade.id ? `poly-act:${trade.id}` : `poly-act:${lock.id}:${trade.qty}`;
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
    source,
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

function matchActivitiesToLocks(activities, locks, { requireMaker = false } = {}) {
  const events = [];
  for (const activity of activities || []) {
    const trade = tradeFromActivity(activity);
    if (!trade) continue;
    if (requireMaker && trade.isAggressor) continue;
    const lock = uniqueLockForMarket(locks, trade.marketSlug, trade.marketSlug);
    if (!lock) continue;
    const evt = activityFillEvent({ trade, lock });
    if (evt) events.push(evt);
  }
  return events;
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

function matchPositionsToLocks(positions, locks) {
  const events = [];
  for (const pos of positions || []) {
    const meta = (pos && pos.marketMetadata) || {};
    const title = meta.title || pos.title || '';
    const slug = pos.marketSlug || meta.slug || '';
    const lock = uniqueLockForMarket(locks, title, slug);
    if (!lock) continue;
    const evt = positionFillEvent({ pos, lock });
    if (evt) events.push(evt);
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
  incrementFromCum,
  reconcileFillId,
  quotesFromListed,
  activitiesFromListed,
  positionsFromListed,
  pendingFromSubmission,
  fillEventFromReconcile,
  lockLabelMatchesMarket,
  uniqueLockForMarket,
  tradeFromActivity,
  activityFillEvent,
  matchActivitiesToLocks,
  positionQty,
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
