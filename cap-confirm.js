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
//
// Holds are never dropped on a timer. A confirm hold stays until its fill is
// booked or the venue order is confirmed dead (createHoldResolver); only
// COMBO_HOLD_HARD_TTL_MS (default 30 min) force-releases, loudly. Every confirm
// takes a last look: filled = max(in-memory, DB, venue-verified) so a fill that
// was never booked cannot hide capacity (2026-10-02 Padres/Yankees/Dodgers
// 1309.48/1251). Kalshi/Polymarket quotes carry no size, so a quote cannot be
// shrunk to the remaining capacity; an RFQ larger than remaining is skipped.
'use strict';

const { wouldExceedCap } = require('./reserve');
const { formatAlertStatus } = require('./venue-alert');

const CLOSED_CONTEXT_TTL_MS = 60_000;
// A confirm hold older than this is UNRESOLVED, not expired: it keeps counting
// against the lock until a resolver proves the order was booked or cancelled
// at the venue (createHoldResolver). Silently dropping it at 90s hid a real
// 91.61-contract Poly fill and let the lock cross its cap (Padres/Yankees/
// Dodgers, 2026-10-02).
const IN_FLIGHT_TTL_MS = 90_000;
// Last resort only: a hold the venue cannot be asked about is force-released
// after this long, loudly (onForced), so a venue outage cannot pin a lock forever.
const IN_FLIGHT_HARD_TTL_MS = Number(process.env.COMBO_HOLD_HARD_TTL_MS) > 0
  ? Number(process.env.COMBO_HOLD_HARD_TTL_MS) : 30 * 60_000;
// A booked fill at least this share of the hold is the whole accept: Kalshi
// takers accept fewer contracts than quoted and fills come back ~4-6% small.
const FINAL_FILL_RATIO = 0.85;

function capAtConfirmEnabled(env = process.env) {
  const src = env || {};
  return /^(1|true|yes)$/i.test(String(src.COMBO_CAP_AT_CONFIRM || ''));
}

function positive(n) {
  const x = typeof n === 'string' ? parseFloat(n) : Number(n);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function createInFlightConfirms({
  now = Date.now, ttlMs = IN_FLIGHT_TTL_MS, hardTtlMs = IN_FLIGHT_HARD_TTL_MS, onForced = null,
} = {}) {
  const by = new Map();

  // Only the hard TTL drops a hold, and it says so. The soft ttl just marks a
  // hold stale so the resolver verifies it against the venue.
  function sweep(at) {
    const t = at != null ? at : now();
    for (const [parlayId, rows] of by) {
      for (const [quoteId, row] of rows) {
        if (row.at != null && t - row.at >= hardTtlMs) {
          rows.delete(quoteId);
          if (typeof onForced === 'function') {
            try { onForced({ parlayId, quoteId, size: row.size, ageMs: t - row.at, meta: row.meta }); } catch (_) {}
          }
        }
      }
      if (!rows.size) by.delete(parlayId);
    }
  }

  function hold(parlayId, quoteId, size, at, meta) {
    const n = positive(size);
    if (parlayId == null || quoteId == null || !(n > 0)) return;
    let rows = by.get(parlayId);
    if (!rows) {
      rows = new Map();
      by.set(parlayId, rows);
    }
    rows.set(quoteId, { size: n, at: at != null ? at : now(), meta: meta || null, checkedAt: null });
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
    else rows.set(quoteId, { ...row, size: left });
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

  // Holds older than minAgeMs (default: the soft ttl), optionally for one lock.
  function stale({ parlayId = null, minAgeMs = ttlMs, at } = {}) {
    const t = at != null ? at : now();
    const out = [];
    for (const [pid, rows] of by) {
      if (parlayId != null && pid !== parlayId) continue;
      for (const [quoteId, row] of rows) {
        const ageMs = row.at != null ? t - row.at : 0;
        if (ageMs >= minAgeMs) {
          out.push({
            parlayId: pid, quoteId, size: row.size, at: row.at, ageMs, meta: row.meta, checkedAt: row.checkedAt,
          });
        }
      }
    }
    return out;
  }

  function touch(parlayId, quoteId, at) {
    const row = by.get(parlayId) && by.get(parlayId).get(quoteId);
    if (row) row.checkedAt = at != null ? at : now();
  }

  function has(parlayId, quoteId) {
    const rows = by.get(parlayId);
    return !!(rows && rows.has(quoteId));
  }

  function size(parlayId, quoteId) {
    const rows = by.get(parlayId);
    const row = rows && rows.get(quoteId);
    return row ? row.size : 0;
  }

  return { hold, release, reduce, sum, sweep, stale, touch, has, size };
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

function createCapBook({
  enabled = false, now, inFlightTtlMs, inFlightHardTtlMs, onForced,
} = {}) {
  const flight = createInFlightConfirms({
    now, ttlMs: inFlightTtlMs, hardTtlMs: inFlightHardTtlMs, onForced,
  });
  const queue = createConfirmQueue();
  return {
    enabled: !!enabled,
    hold: flight.hold,
    release: flight.release,
    reduce: flight.reduce,
    sum: flight.sum,
    sweep: flight.sweep,
    stale: flight.stale,
    touch: flight.touch,
    has: flight.has,
    holdSize: flight.size,
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
    // Last look: the in-memory count can be behind the books (a fill booked by
    // another path, or one that was never booked here). Re-read from the DB and,
    // when the lock has unresolved holds, from the venue, and trust the larger.
    let filled = typeof args.getFilled === 'function' ? Number(await args.getFilled()) || 0 : 0;
    if (typeof args.lastLook === 'function') {
      try {
        const fresh = Number(await args.lastLook()) || 0;
        if (fresh > filled) {
          if (typeof args.onLastLookRaise === 'function') args.onLastLookRaise({ memory: filled, fresh });
          filled = fresh;
        }
      } catch (_) { /* last look is best-effort; the in-memory count still gates */ }
    }
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
    if (book && book.enabled) book.hold(args.parlayId, args.quoteId, size, undefined, args.meta);
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

// A booked fill that is the whole accept (>= FINAL_FILL_RATIO of the hold)
// releases the hold; a smaller one only reduces it and the rest is verified by
// the resolver. Without this a normal Kalshi fill (4-6% under the quote) was
// "partial" and left the remainder pinned until the TTL, over-reserving.
function isFinalFill(held, contracts) {
  const h = positive(held);
  const c = positive(contracts);
  if (!(h > 0)) return true;
  return c >= h * FINAL_FILL_RATIO - 1e-9;
}

function releaseConfirmedFill(book, { parlayId, quoteId, partial, contracts, held } = {}) {
  if (!book || !book.enabled || parlayId == null || quoteId == null) return;
  const heldSize = held != null ? held : (typeof book.holdSize === 'function' ? book.holdSize(parlayId, quoteId) : null);
  if (partial && !(heldSize != null && isFinalFill(heldSize, contracts))) book.reduce(parlayId, quoteId, contracts);
  else book.release(parlayId, quoteId);
}

// Verifies holds that outlived the soft ttl (or are about to gate a confirm).
// check(row) -> { state: 'booked' | 'cancelled' | 'filled_unbooked' | 'open' | 'unknown' }.
//  booked / cancelled  -> release (the fill is in the count, or the order is dead)
//  filled_unbooked     -> keep the hold, call onFilledUnbooked(row, res) to book it
//  open / unknown      -> keep the hold (the hard ttl is the only exit)
function createHoldResolver({
  book, check, onFilledUnbooked = null, now = Date.now, log = () => {},
  minRecheckMs = 15_000, maxPerTick = 4,
} = {}) {
  async function resolveRow(row) {
    book.touch(row.parlayId, row.quoteId, now());
    let res;
    try {
      res = await check(row);
    } catch (e) {
      res = { state: 'unknown', error: e && e.message };
    }
    const state = (res && res.state) || 'unknown';
    if (state === 'booked' || state === 'cancelled') {
      book.release(row.parlayId, row.quoteId);
      log(`HOLD RELEASED (${state}) quote_id=${row.quoteId} lock=${row.parlayId} size=${row.size} age=${Math.round(row.ageMs / 1000)}s`);
    } else if (state === 'filled_unbooked') {
      log(`HOLD KEPT (filled at venue, not booked) quote_id=${row.quoteId} lock=${row.parlayId} size=${row.size} contracts=${res.contracts != null ? res.contracts : '?'}`);
      if (typeof onFilledUnbooked === 'function') {
        try { await onFilledUnbooked(row, res); } catch (e) {
          log(`HOLD rebook failed quote_id=${row.quoteId} ${e && e.message}`);
        }
      }
    } else {
      log(`HOLD KEPT (${state}) quote_id=${row.quoteId} lock=${row.parlayId} size=${row.size} age=${Math.round(row.ageMs / 1000)}s`);
    }
    return { row, state };
  }

  function due(rows, t) {
    return rows.filter((r) => r.checkedAt == null || t - r.checkedAt >= minRecheckMs);
  }

  async function tick() {
    if (!book || !book.enabled) return [];
    const t = now();
    book.sweep(t);
    const rows = due(book.stale({ at: t }), t).slice(0, maxPerTick);
    const out = [];
    for (const row of rows) out.push(await resolveRow(row));
    return out;
  }

  // Last look for one lock before a confirm. Younger holds than minAgeMs are
  // normal in-flight confirms; older ones should have booked by now.
  async function resolveParlay(parlayId, { minAgeMs = 10_000, max = 3 } = {}) {
    if (!book || !book.enabled || parlayId == null) return [];
    const t = now();
    const rows = due(book.stale({ parlayId, minAgeMs, at: t }), t).slice(0, max);
    const out = [];
    for (const row of rows) out.push(await resolveRow(row));
    return out;
  }

  return { tick, resolveParlay, resolveRow };
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
  IN_FLIGHT_HARD_TTL_MS,
  FINAL_FILL_RATIO,
  isFinalFill,
  createHoldResolver,
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
