// Realtime Bet Protect decisions for an armed desk rest.
//
// The book and trade rules match aibetbuilder src/liveDeskProtect.js
// evaluateBookProtect / evaluateTradeProtect (main after PRs #573 and #574):
// cancel only when depth beyond our own size, or a print, is more than the
// cushion through our price. Re-rest pricing stays in aibetbuilder.
'use strict';

const MICRO = 1_000_000;
const PROTECT_FEED_STALE_MS = 8000;
const PROTECT_TRADE_FRESH_MS = 15000;

function amountValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeOutcome(outcome) {
  const s = String(outcome || '').trim().toLowerCase();
  if (s === 'long' || s === 'yes' || s === 'buy_long') return 'long';
  if (s === 'short' || s === 'no' || s === 'buy_short') return 'short';
  return '';
}

function normalizeAction(action) {
  const s = String(action || '').trim().toLowerCase();
  if (s === 'buy' || s === 'b') return 'buy';
  if (s === 'sell' || s === 's') return 'sell';
  return '';
}

function centsToMicro(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10_000);
}

function levelPrice(level) {
  if (!level || typeof level !== 'object') return null;
  return amountValue(level.px != null ? level.px : level.price);
}

function levelQty(level) {
  if (!level || typeof level !== 'object') return null;
  const n = Number(level.qty != null ? level.qty : level.quantity);
  return Number.isFinite(n) ? n : null;
}

function ownQtyAt(orders, yesPrice) {
  let sum = 0;
  for (const order of orders || []) {
    const px = Number(order && order.yesPrice);
    const qty = Number(order && order.leaves);
    if (!Number.isFinite(px) || !Number.isFinite(qty) || !(qty > 0)) continue;
    if (Math.abs(px - yesPrice) <= 5e-5) sum += qty;
  }
  return sum;
}

function normalizeBookLevels(levels, { better = 'higher' } = {}) {
  const byMicro = new Map();
  for (const level of levels || []) {
    const price = levelPrice(level);
    const qty = levelQty(level);
    if (!(price > 0 && price < 1) || qty == null || qty < 0) continue;
    const micro = Math.round(price * MICRO);
    if (!(micro > 0 && micro < MICRO)) continue;
    byMicro.set(micro, (byMicro.get(micro) || 0) + qty);
  }
  const rows = [];
  for (const [micro, qty] of byMicro) rows.push({ price: micro / MICRO, qty });
  rows.sort((a, b) => (better === 'lower' ? a.price - b.price : b.price - a.price));
  return rows;
}

function outsideTouch(levels, ownOrdersAtPrice, ourPrice, { better = 'higher' } = {}) {
  const ours = Number(ourPrice);
  const rows = normalizeBookLevels(levels, { better });
  if (!(ours > 0 && ours < 1)) return { ok: false, reason: 'unpriced' };
  const idx = rows.findIndex((row) => Math.abs(row.price - ours) <= 5e-5);
  if (idx < 0) {
    const ahead = rows.find((row) => (better === 'higher' ? row.price > ours + 5e-5 : row.price < ours - 5e-5));
    if (ahead) return { ok: true, price: ahead.price, reason: 'ahead' };
    return { ok: false, reason: 'absent' };
  }
  const own = ownQtyAt(ownOrdersAtPrice, rows[idx].price);
  const outside = rows[idx].qty - own;
  if (outside < -1e-4) return { ok: false, reason: 'inconsistent' };
  if (outside > 1e-4) return { ok: true, price: rows[idx].price, reason: 'shared' };
  for (let i = idx + 1; i < rows.length; i += 1) {
    const nextOwn = ownQtyAt(ownOrdersAtPrice, rows[i].price);
    const nextOutside = rows[i].qty - nextOwn;
    if (nextOutside < -1e-4) return { ok: false, reason: 'inconsistent' };
    if (nextOutside > 1e-4) return { ok: true, price: rows[i].price, reason: 'outside' };
  }
  return { ok: false, reason: 'truncated' };
}

function evaluateBookProtect({
  outcome,
  action,
  yesPrice,
  bids,
  offers,
  ownBids,
  ownOffers,
  xCents,
  feedAgeMs,
  receivedAgeMs,
} = {}) {
  const received = receivedAgeMs == null || receivedAgeMs === '' ? null : Number(receivedAgeMs);
  const lastChange = feedAgeMs == null || feedAgeMs === '' ? null : Number(feedAgeMs);
  if (received != null && Number.isFinite(received)) {
    if (received > PROTECT_FEED_STALE_MS || received < 0) {
      return { fire: false, reason: 'stale-receipt', refKind: 'unsolved', lastChangeMs: Number.isFinite(lastChange) ? lastChange : null };
    }
  } else if (lastChange == null || !Number.isFinite(lastChange)) {
    return { fire: false, reason: 'age-unknown', refKind: 'unsolved' };
  } else if (lastChange > PROTECT_FEED_STALE_MS || lastChange < -PROTECT_FEED_STALE_MS) {
    return { fire: false, reason: 'stale-feed', refKind: 'unsolved' };
  }
  const yes = Number(yesPrice);
  const xMicro = centsToMicro(xCents);
  const act = normalizeAction(action);
  const side = normalizeOutcome(outcome);
  if (!(yes > 0 && yes < 1) || !act || !side || xMicro == null) {
    return { fire: false, reason: 'unpriced', refKind: 'unsolved' };
  }
  const bidRows = normalizeBookLevels(bids, { better: 'higher' });
  const askRows = normalizeBookLevels(offers, { better: 'lower' });
  const bestBid = bidRows.length ? bidRows[0].price : null;
  const bestAsk = askRows.length ? askRows[0].price : null;
  if (bestBid != null && bestAsk != null && bestBid + 1e-9 >= bestAsk) {
    return { fire: false, reason: 'crossed', refKind: 'unsolved' };
  }
  const bookSide = side === 'short' ? (act === 'buy' ? 'sell' : 'buy') : act;
  const levels = bookSide === 'sell' ? offers : bids;
  const own = bookSide === 'sell' ? ownOffers : ownBids;
  const touch = outsideTouch(levels, own, yes, { better: bookSide === 'sell' ? 'lower' : 'higher' });
  if (!touch.ok) return { fire: false, reason: touch.reason, refKind: 'unsolved' };
  const gap = bookSide === 'sell' ? touch.price - yes : yes - touch.price;
  const gapMicro = Math.round(gap * MICRO);
  const reference = side === 'short' ? 1 - touch.price : touch.price;
  if (gapMicro < 0) return { fire: false, reason: 'ran-away', gapMicro, refKind: touch.reason, referenceMicro: Math.round(reference * MICRO) };
  if (gapMicro <= xMicro) return { fire: false, reason: 'inside', gapMicro, refKind: touch.reason, referenceMicro: Math.round(reference * MICRO) };
  return { fire: true, reason: 'through', gapMicro, refKind: touch.reason, referenceMicro: Math.round(reference * MICRO) };
}

function evaluateTradeProtect({
  outcome,
  action,
  yesPrice,
  tradeYes,
  tradeAtMs,
  nowMs,
  xCents,
  ownYesPrices,
} = {}) {
  const yes = Number(yesPrice);
  const px = Number(tradeYes);
  const act = normalizeAction(action);
  const side = normalizeOutcome(outcome);
  const xMicro = centsToMicro(xCents);
  if (!(yes > 0 && yes < 1) || !(px > 0 && px < 1) || !act || !side || xMicro == null) {
    return { fire: false, reason: 'no-trade' };
  }
  const at = Number(tradeAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return { fire: false, reason: 'trade-time-unknown' };
  const age = now - at;
  if (age < 0 || age > PROTECT_TRADE_FRESH_MS) return { fire: false, reason: 'trade-old' };
  for (const own of ownYesPrices || []) {
    if (Math.abs(Number(own) - px) <= 5e-5) return { fire: false, reason: 'own-fill' };
  }
  const tradeOutcome = side === 'short' ? 1 - px : px;
  const ourOutcome = side === 'short' ? 1 - yes : yes;
  const gapMicro = Math.round((act === 'buy' ? ourOutcome - tradeOutcome : tradeOutcome - ourOutcome) * MICRO);
  const referenceMicro = Math.round(tradeOutcome * MICRO);
  if (gapMicro <= xMicro) return { fire: false, reason: 'inside', gapMicro, referenceMicro };
  return { fire: true, reason: 'trade-through', gapMicro, referenceMicro };
}

function bookSideOf(outcome, action) {
  const side = normalizeOutcome(outcome);
  const act = normalizeAction(action);
  if (!side || !act) return '';
  if (side === 'short') return act === 'buy' ? 'sell' : 'buy';
  return act;
}

function isPolymarketSlug(slug) {
  const s = String(slug || '').trim();
  return !!s && !s.startsWith('novig:');
}

module.exports = {
  MICRO,
  PROTECT_FEED_STALE_MS,
  PROTECT_TRADE_FRESH_MS,
  amountValue,
  normalizeBookLevels,
  outsideTouch,
  evaluateBookProtect,
  evaluateTradeProtect,
  bookSideOf,
  isPolymarketSlug,
  centsToMicro,
};
