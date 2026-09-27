// Kalshi quote_executed means orders were placed on the book, not that a
// trade filled. Portfolio fills (GET /portfolio/fills, and historical fills
// past the cutoff) are the only contract counts that may hit combo_fills or
// a lock's max_contracts. Partial fills are separate fill_ids. Sizes are
// fixed-point count_fp strings, including fractions.
'use strict';
const { isQuoteExecutionStub, isKalshiTradeFill, isPolyishFill } = require('./fills-attr');

const COUNT_EPS = 0.001;

function isComboTicker(ticker) {
  return !!ticker && /MVE/i.test(ticker);
}

// Prefer count_fp. Legacy integer `count` truncates fractional contracts
// (Kalshi emits both during the fixed-point migration; responses always
// carry count_fp at 0.01 granularity).
function fillContractCount(fill) {
  if (!fill || typeof fill !== 'object') return null;
  const raw = fill.raw && typeof fill.raw === 'object' ? fill.raw : null;
  const fp = fill.count_fp != null && fill.count_fp !== ''
    ? fill.count_fp
    : (raw && raw.count_fp != null && raw.count_fp !== '' ? raw.count_fp : null);
  const chosen = fp != null ? fp : (fill.count != null ? fill.count : null);
  if (chosen == null || chosen === '') return null;
  const n = Number(chosen);
  return Number.isFinite(n) ? n : null;
}

function countsClose(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= COUNT_EPS;
}

function normalizeKalshiFill(f) {
  const src = f || {};
  const fillId = src.fill_id || src.trade_id || null;
  const ticker = src.ticker || src.market_ticker || null;
  const count = fillContractCount(src);
  const created = src.created_time || (src.ts ? new Date(src.ts * 1000).toISOString() : null);
  const yesP = src.yes_price_dollars ?? src.yes_price_fixed ?? (src.yes_price != null ? src.yes_price / 100 : null);
  const noP = src.no_price_dollars ?? src.no_price_fixed ?? (src.no_price != null ? src.no_price / 100 : null);
  return {
    fill_id: fillId,
    order_id: src.order_id || src.creator_order_id || null,
    ticker,
    is_combo: isComboTicker(ticker),
    outcome_side: src.outcome_side || src.side || null,
    action: src.action || null,
    count: count == null ? 0 : count,
    is_taker: !!src.is_taker,
    yes_price: yesP != null ? Number(yesP) : null,
    no_price: noP != null ? Number(noP) : null,
    fee: src.fee_cost != null ? Number(src.fee_cost) : (src.fee != null ? Number(src.fee) : null),
    kalshi_created_time: created,
    raw: src,
  };
}

function orderKeysOfFill(fill) {
  if (!fill) return [];
  const keys = [
    fill.order_id,
    fill.creator_order_id,
    fill.client_order_id,
    fill.rfq_creator_order_id,
  ];
  return keys.filter((id) => id != null && id !== '');
}

function fillReferencesOrder(fill, orderId) {
  if (!fill || !orderId) return false;
  return orderKeysOfFill(fill).some((id) => id === orderId);
}

function fillsQuery({ orderId, minTs, cursor, limit } = {}) {
  const q = new URLSearchParams();
  q.set('limit', String(limit || 200));
  if (orderId) q.set('order_id', String(orderId));
  if (minTs != null && minTs !== '') q.set('min_ts', String(minTs));
  if (cursor) q.set('cursor', String(cursor));
  return q.toString();
}

// Quote execution is not a fill. Book only portfolio rows for this order,
// at count_fp, one row per fill_id (partials add). The quoted contract
// count is ignored on purpose.
function bookFromQuoteExecution({ orderId, fills } = {}) {
  if (!orderId) return { book: [], contracts: 0, reason: 'no-order-id' };
  const matched = (fills || []).filter((fill) => fillReferencesOrder(fill, orderId));
  const book = [];
  const seen = new Set();
  for (const fill of matched) {
    const row = normalizeKalshiFill(fill);
    if (!row.fill_id || !(row.count > 0) || seen.has(row.fill_id)) continue;
    seen.add(row.fill_id);
    book.push(row);
  }
  if (!book.length) return { book: [], contracts: 0, reason: 'no-portfolio-fill' };
  const contracts = book.reduce((sum, row) => sum + row.count, 0);
  return { book, contracts, reason: 'confirmed' };
}

function buildKalshiFillIndex(fills) {
  const byFillId = new Map();
  const byOrderId = new Map();
  for (const fill of fills || []) {
    if (!fill) continue;
    const id = fill.fill_id || fill.trade_id;
    if (id && !byFillId.has(id)) byFillId.set(id, fill);
    for (const key of orderKeysOfFill(fill)) {
      if (!byOrderId.has(key)) byOrderId.set(key, []);
      const list = byOrderId.get(key);
      if (id && list.some((row) => (row.fill_id || row.trade_id) === id)) continue;
      list.push(fill);
    }
  }
  return {
    byFillId,
    matches(key) {
      if (!key || !byOrderId.has(key)) return [];
      return byOrderId.get(key).slice();
    },
  };
}

function fillsConfirmingRow(index, row) {
  const found = [];
  const seen = new Set();
  const push = (fill) => {
    if (!fill) return;
    const id = fill.fill_id || fill.trade_id || null;
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    found.push(fill);
  };
  for (const key of [row && row.order_id, row && row.fill_id]) {
    if (!key) continue;
    if (index.byFillId.has(key)) push(index.byFillId.get(key));
    for (const fill of index.matches(key)) push(fill);
  }
  return found;
}

function rowToInsert(fill, stub) {
  const row = normalizeKalshiFill(fill);
  if (!row.fill_id || !(row.count > 0)) return null;
  return {
    ...row,
    parlay_id: (stub && stub.parlay_id) || null,
    is_combo: true,
    is_taker: row.is_taker,
  };
}

// Compare stored combo_fills to Kalshi fill history.
// - Phantom quote stubs (executed quote, no portfolio fill) are dropped.
// - A stub whose order did fill is dropped and any missing partial fills are
//   inserted at count_fp, keeping the stub's parlay_id.
// - A stored trade whose count drifted from count_fp is corrected.
// Polymarket rows are never changed. Unverified order ids are skipped.
function planKalshiFillReconcile(dbRows, kalshiFills, opts = {}) {
  const unverified = opts.unverifiedOrderIds instanceof Set
    ? opts.unverifiedOrderIds
    : new Set(opts.unverifiedOrderIds || []);
  const index = buildKalshiFillIndex(kalshiFills);
  const dbFillIds = new Set((dbRows || []).map((row) => row && row.fill_id).filter(Boolean));
  const drop = [];
  const insert = [];
  const countFixes = [];
  const skipped = [];
  const insertIds = new Set();

  for (const row of dbRows || []) {
    if (!row || isPolyishFill(row)) continue;

    const orderKey = row.order_id || row.fill_id;
    if (isQuoteExecutionStub(row) && orderKey && unverified.has(orderKey)) {
      skipped.push({ ...row, reason: 'kalshi-lookup-failed' });
      continue;
    }

    if (!isQuoteExecutionStub(row)) {
      if (!isKalshiTradeFill(row) && !(row.fill_id && index.byFillId.has(row.fill_id))) continue;
      const live = index.byFillId.get(row.fill_id);
      if (!live) continue;
      const next = fillContractCount(live);
      const prev = Number(row.count);
      if (next == null || !Number.isFinite(prev) || countsClose(prev, next)) continue;
      countFixes.push({
        fill_id: row.fill_id,
        from: prev,
        to: next,
        parlay_id: row.parlay_id || null,
        order_id: row.order_id || null,
      });
      continue;
    }

    const matches = fillsConfirmingRow(index, row);
    const stubIsFill = matches.some((fill) => (fill.fill_id || fill.trade_id) === row.fill_id);
    if (stubIsFill) {
      const live = matches.find((fill) => (fill.fill_id || fill.trade_id) === row.fill_id);
      const next = fillContractCount(live);
      const prev = Number(row.count);
      if (next != null && Number.isFinite(prev) && !countsClose(prev, next)) {
        countFixes.push({
          fill_id: row.fill_id,
          from: prev,
          to: next,
          parlay_id: row.parlay_id || null,
          order_id: row.order_id || null,
        });
      }
      continue;
    }

    if (!matches.length) {
      drop.push({ ...row, reason: 'no-kalshi-fill' });
      continue;
    }

    drop.push({ ...row, reason: 'quote-stub-superseded' });
    for (const fill of matches) {
      const id = fill.fill_id || fill.trade_id;
      if (!id || dbFillIds.has(id) || insertIds.has(id)) continue;
      const stored = rowToInsert(fill, row);
      if (!stored) continue;
      insertIds.add(id);
      insert.push(stored);
    }
  }

  return { drop, insert, countFixes, skipped };
}

function planNetContracts(plan) {
  let delta = 0;
  for (const row of (plan && plan.drop) || []) delta -= Number(row.count) || 0;
  for (const row of (plan && plan.insert) || []) delta += Number(row.count) || 0;
  for (const fix of (plan && plan.countFixes) || []) delta += Number(fix.to) - Number(fix.from);
  return delta;
}

function describeReconcilePlan(plan, { dryRun = true } = {}) {
  const verbDrop = dryRun ? 'would drop' : 'dropping';
  const verbInsert = dryRun ? 'would insert' : 'inserting';
  const verbUpdate = dryRun ? 'would update' : 'updating';
  const lines = [];
  for (const row of (plan && plan.drop) || []) {
    lines.push(
      `${verbDrop} fill_id=${row.fill_id} count=${row.count} order_id=${row.order_id || '—'} ` +
      `parlay=${row.parlay_id || '—'} reason=${row.reason}`
    );
  }
  for (const row of (plan && plan.insert) || []) {
    lines.push(
      `${verbInsert} fill_id=${row.fill_id} count=${row.count} order_id=${row.order_id || '—'} ` +
      `parlay=${row.parlay_id || '—'}`
    );
  }
  for (const fix of (plan && plan.countFixes) || []) {
    lines.push(
      `${verbUpdate} fill_id=${fix.fill_id} count ${fix.from} -> ${fix.to} parlay=${fix.parlay_id || '—'}`
    );
  }
  for (const row of (plan && plan.skipped) || []) {
    lines.push(
      `skip fill_id=${row.fill_id} order_id=${row.order_id || '—'} reason=${row.reason}`
    );
  }
  const net = planNetContracts(plan);
  lines.push(
    `summary drop=${(plan.drop || []).length} insert=${(plan.insert || []).length} ` +
    `count_fixes=${(plan.countFixes || []).length} skipped=${(plan.skipped || []).length} ` +
    `net_contracts=${net} dry=${dryRun ? 'yes' : 'no'}`
  );
  return lines;
}

function reconcileMode(argv, env = {}) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes('--apply')) return 'apply';
  if (args.includes('--dry-run')) return 'dry-run';
  if (/^(1|true|yes|on)$/i.test(String(env.RECONCILE_APPLY || ''))) return 'apply';
  return 'dry-run';
}

function reconcileFetchUsable(result) {
  return !!(result && result.ok === true && !result.truncated);
}

async function collectFillPages(fetchPage, { maxPages = 100 } = {}) {
  const fills = [];
  let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    if (!page || page.ok === false) {
      return { ok: false, error: (page && page.error) || 'fills page failed', fills, truncated: false };
    }
    const batch = page.fills || [];
    fills.push(...batch);
    if (!page.cursor || !batch.length) return { ok: true, fills, truncated: false };
    cursor = page.cursor;
  }
  return { ok: true, fills, truncated: true };
}

async function applyKalshiFillPlan(io, plan, { dryRun = true, log = () => {} } = {}) {
  const lines = describeReconcilePlan(plan, { dryRun });
  for (const line of lines) log(line);
  if (dryRun) {
    return { dryRun: true, dropped: 0, inserted: 0, updated: 0, lines };
  }
  let dropped = 0;
  let inserted = 0;
  let updated = 0;
  for (const row of plan.drop || []) {
    if (!row.fill_id) continue;
    await io.deleteFill(row.fill_id);
    dropped += 1;
  }
  for (const row of plan.insert || []) {
    if (!row.fill_id) continue;
    await io.insertFill(row);
    inserted += 1;
  }
  for (const fix of plan.countFixes || []) {
    if (!fix.fill_id) continue;
    await io.updateCount(fix.fill_id, fix.to);
    updated += 1;
  }
  return { dryRun: false, dropped, inserted, updated, lines };
}

module.exports = {
  COUNT_EPS,
  isComboTicker,
  fillContractCount,
  countsClose,
  normalizeKalshiFill,
  orderKeysOfFill,
  fillReferencesOrder,
  fillsQuery,
  bookFromQuoteExecution,
  buildKalshiFillIndex,
  fillsConfirmingRow,
  planKalshiFillReconcile,
  planNetContracts,
  describeReconcilePlan,
  reconcileMode,
  reconcileFetchUsable,
  collectFillPages,
  applyKalshiFillPlan,
};
