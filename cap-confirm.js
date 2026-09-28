// Cap enforcement at confirm time.
//
// COMBO_CAP_AT_CONFIRM=1 (default off): open unaccepted quotes do not reserve
// a lock's remaining. Quote time still skips an RFQ whose own size exceeds
// max - confirmed fills - confirms already in flight. Confirm time, per lock,
// is serialized and checks fills + in-flight confirms + this accept.
//
// Flag off keeps today's outstanding-quote reserve (reserve.js).
//
// Polymarket safety does not depend on the flag: quote context survives
// rfqClosed for CLOSED_CONTEXT_TTL_MS, a missing context does not confirm,
// and a fill larger than the quoted size is flagged. Polymarket confirms
// are capped against the largest size that accept could still fill.
'use strict';

const { wouldExceedCap } = require('./reserve');
const { formatAlertStatus } = require('./venue-alert');

const CLOSED_CONTEXT_TTL_MS = 60_000;
// A confirm that never reports a fill must not pin the lock forever.
const IN_FLIGHT_TTL_MS = 90_000;

function capAtConfirmEnabled(env = process.env) {
  const src = env || {};
  return /^(1|true|yes)$/i.test(String(src.COMBO_CAP_AT_CONFIRM || ''));
}

function positive(n) {
  const x = typeof n === 'string' ? parseFloat(n) : Number(n);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function createInFlightConfirms({ now = Date.now, ttlMs = IN_FLIGHT_TTL_MS } = {}) {
  const by = new Map();

  function sweep(at) {
    const t = at != null ? at : now();
    for (const [parlayId, rows] of by) {
      for (const [quoteId, row] of rows) {
        if (row.at != null && t - row.at >= ttlMs) rows.delete(quoteId);
      }
      if (!rows.size) by.delete(parlayId);
    }
  }

  function hold(parlayId, quoteId, size, at) {
    const n = positive(size);
    if (parlayId == null || quoteId == null || !(n > 0)) return;
    let rows = by.get(parlayId);
    if (!rows) {
      rows = new Map();
      by.set(parlayId, rows);
    }
    rows.set(quoteId, { size: n, at: at != null ? at : now() });
  }

  function release(parlayId, quoteId) {
    const rows = by.get(parlayId);
    if (!rows) return;
    rows.delete(quoteId);
    if (!rows.size) by.delete(parlayId);
  }

  function reduce(parlayId, quoteId, amount) {
    const rows = by.get(parlayId);
    if (!rows || !rows.has(quoteId)) return;
    const row = rows.get(quoteId);
    const left = row.size - positive(amount);
    if (!(left > 1e-9)) release(parlayId, quoteId);
    else rows.set(quoteId, { size: left, at: row.at });
  }

  function sum(parlayId, excludeQuoteId, at) {
    sweep(at);
    const rows = by.get(parlayId);
    if (!rows) return 0;
    let n = 0;
    for (const [id, row] of rows) {
      if (excludeQuoteId != null && id === excludeQuoteId) continue;
      n += row.size;
    }
    return n;
  }

  return { hold, release, reduce, sum, sweep };
}

function createConfirmQueue() {
  const tails = new Map();

  function run(key, fn) {
    const k = key == null ? '' : String(key);
    const prev = tails.get(k) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tracked = next.finally(() => {
      if (tails.get(k) === tracked) tails.delete(k);
    });
    tails.set(k, tracked);
    return next;
  }

  return { run };
}

function createClosedContext({ ttlMs = CLOSED_CONTEXT_TTL_MS, now = Date.now } = {}) {
  const map = new Map();

  function sweep(at) {
    const t = at != null ? at : now();
    for (const [id, row] of map) {
      if (row.expiresAt <= t) map.delete(id);
    }
  }

  function put(quoteId, pending, at) {
    if (quoteId == null || !pending) return;
    const t = at != null ? at : now();
    map.set(String(quoteId), {
      pending: { ...pending },
      expiresAt: t + ttlMs,
    });
  }

  function get(quoteId, at) {
    if (quoteId == null) return null;
    sweep(at);
    const row = map.get(String(quoteId));
    return row ? row.pending : null;
  }

  function take(quoteId, at) {
    const pending = get(quoteId, at);
    if (pending) map.delete(String(quoteId));
    return pending;
  }

  function drop(quoteId) {
    if (quoteId == null) return;
    map.delete(String(quoteId));
  }

  return { put, get, take, drop, sweep, ttlMs };
}

function createCapBook({ enabled = false, now, inFlightTtlMs } = {}) {
  const flight = createInFlightConfirms({ now, ttlMs: inFlightTtlMs });
  const queue = createConfirmQueue();
  return {
    enabled: !!enabled,
    hold: flight.hold,
    release: flight.release,
    reduce: flight.reduce,
    sum: flight.sum,
    sweep: flight.sweep,
    run: queue.run,
    exposure(openOutstanding, parlayId, excludeQuoteId) {
      if (!this.enabled) {
        const n = Number(openOutstanding);
        return Number.isFinite(n) && n > 0 ? n : 0;
      }
      return this.sum(parlayId, excludeQuoteId);
    },
  };
}

// Check + reserve under the per-lock queue when the flag is on.
// `size` is the amount this accept can add. Flag off uses `getOpenHeld`
// (other open quotes) and does not queue.
async function confirmAgainstCap(book, args) {
  const run = async () => {
    const filled = typeof args.getFilled === 'function' ? Number(args.getFilled()) || 0 : 0;
    const openHeld = typeof args.getOpenHeld === 'function' ? Number(args.getOpenHeld()) || 0 : 0;
    const held = book && book.enabled
      ? book.sum(args.parlayId, args.quoteId)
      : (openHeld > 0 ? openHeld : 0);
    const size = positive(args.size);
    if (wouldExceedCap(args.maxContracts, filled, held, size)) {
      const info = {
        ok: false,
        reason: 'cap_exceeded',
        filled,
        held,
        size,
        maxContracts: args.maxContracts,
      };
      if (typeof args.onExceed === 'function') await args.onExceed(info);
      return info;
    }
    if (book && book.enabled) book.hold(args.parlayId, args.quoteId, size);
    try {
      await args.confirm();
      return { ok: true, filled, held, size };
    } catch (err) {
      if (book && book.enabled) book.release(args.parlayId, args.quoteId);
      throw err;
    }
  };
  if (book && book.enabled && args.parlayId != null) return book.run(args.parlayId, run);
  return run();
}

function releaseConfirmedFill(book, { parlayId, quoteId, partial, contracts } = {}) {
  if (!book || !book.enabled || parlayId == null || quoteId == null) return;
  if (partial) book.reduce(parlayId, quoteId, contracts);
  else book.release(parlayId, quoteId);
}

const POLY_SIZE_KEYS = [
  'acceptedQty', 'accepted_qty', 'acceptQty', 'accept_qty', 'acceptedQuantity',
  'qtyDecimal', 'qty_decimal', 'quantity', 'qty', 'size', 'contracts', 'shares',
  'buyQtyDecimal', 'buy_qty_decimal',
  'lastShares', 'last_shares', 'cumQuantity', 'cum_quantity', 'cumQty',
  'fillQty', 'filledQty', 'filled_qty',
];

function maxSizeFields(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let m = 0;
  for (const key of POLY_SIZE_KEYS) {
    if (obj[key] != null && obj[key] !== '') m = Math.max(m, positive(obj[key]));
  }
  return m;
}

// Largest Polymarket fill this accept could still produce. Quoted size, the
// RFQ's own qty, the unclipped estimate, cash/price, and any size on the
// accept all count. Confirm caps against that, not only the number we posted.
function maxPolymarketFillSize(pending, evt) {
  const quoted = positive(pending && pending.contracts);
  const rfqQty = positive(pending && pending.rfqQty);
  const estimated = positive(pending && pending.estimatedContracts);
  const cash = positive(pending && pending.cashOrderQty);
  const px = positive(pending && pending.buyPrice);
  const cashShares = (cash > 0 && px > 0 && px < 1) ? cash / px : 0;
  return Math.max(
    quoted,
    rfqQty,
    estimated,
    cashShares,
    maxSizeFields(evt && evt.quote),
    maxSizeFields(evt && evt.rfq),
    maxSizeFields(evt),
  );
}

function overfillOf(quoted, filled) {
  const q = positive(quoted);
  const f = positive(filled);
  if (!(q > 0) || !(f > q + 1e-6)) return null;
  return { quoted: q, filled: f };
}

function formatOverfillLog(mode, info) {
  return `[${mode}] OVERFILL ${info.label || '(unknown)'} quote_id=${info.quoteId || '?'} ` +
    `quoted=${info.quoted} filled=${info.filled}`;
}

function formatOverfillAlert(info) {
  const venue = info.venue || 'polymarket';
  const quote = info.quoteShort || info.quoteId || '?';
  return `${formatAlertStatus('⚠️ OVERFILL', venue)} — ${info.label || '(unknown)'}\n` +
    `quote ${quote}\n` +
    `quoted ${info.quoted} · filled ${info.filled}`;
}

function formatCapSkip({
  mode, quoteId, rfqId, label, filled, held, size, quoted, maxContracts, enabled,
}) {
  const heldWord = enabled ? 'inFlight' : 'reserved';
  const quotedBit = quoted > 0 && size > quoted + 1e-6 ? ` quoted=${quoted}` : '';
  return `[${mode}] CONFIRM SKIPPED cap exceeded quote_id=${quoteId || '?'} ` +
    `rfq_id=${rfqId || '?'} label=${label || '(unknown)'} ` +
    `filled=${filled} ${heldWord}=${held} want=${size}${quotedBit} max=${maxContracts}`;
}

function formatMissingContext(mode, quoteId, rfqId) {
  return `[${mode}] CONFIRM SKIPPED missing context quote_id=${quoteId || '?'} ` +
    `rfq_id=${rfqId || '?'} — not confirming`;
}

module.exports = {
  CLOSED_CONTEXT_TTL_MS,
  IN_FLIGHT_TTL_MS,
  capAtConfirmEnabled,
  positive,
  createInFlightConfirms,
  createConfirmQueue,
  createClosedContext,
  createCapBook,
  confirmAgainstCap,
  releaseConfirmedFill,
  maxPolymarketFillSize,
  overfillOf,
  formatOverfillLog,
  formatOverfillAlert,
  formatCapSkip,
  formatMissingContext,
};
