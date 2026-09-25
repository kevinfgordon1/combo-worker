// Normalize Kalshi and Polymarket US books/trades into bid/ask levels.
// Read-only shapes. No HTTP.
'use strict';

const { roundCent } = require('./mm-paper-math');

function asNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    if (v.value != null) return asNumber(v.value);
    if (v.price != null) return asNumber(v.price);
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asPrice(v) {
  const n = asNumber(v);
  if (n == null) return null;
  if (n > 1 && n <= 100) return roundCent(n / 100);
  if (n > 0 && n < 1) return roundCent(n);
  return null;
}

function asQty(v) {
  const n = asNumber(v);
  if (n == null || !(n > 0)) return null;
  return n;
}

function pushLevel(out, price, size) {
  const p = asPrice(price);
  const q = asQty(size);
  if (p == null || q == null) return;
  const prev = out.find((l) => Math.abs(l.price - p) < 0.0005);
  if (prev) prev.size += q;
  else out.push({ price: p, size: q });
}

function sortBook(book) {
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
  return book;
}

function emptyBook() {
  return { bids: [], asks: [] };
}

function bookTop(book) {
  const b = book || emptyBook();
  const bestBid = b.bids && b.bids.length ? b.bids[0].price : null;
  const bestAsk = b.asks && b.asks.length ? b.asks[0].price : null;
  const bidSize = b.bids && b.bids.length ? b.bids[0].size : null;
  let mid = null;
  if (bestBid != null && bestAsk != null && bestAsk > bestBid) mid = (bestBid + bestAsk) / 2;
  return { bestBid, bestAsk, bidSize, mid };
}

function sizeAtBid(book, price) {
  if (!book || price == null) return null;
  const lvl = (book.bids || []).find((l) => Math.abs(l.price - price) < 0.0005);
  if (!lvl) return 0;
  return lvl.size;
}

// Kalshi orderbook: YES bids, and NO bids which are YES asks at 1 - price.
function parseKalshiOrderbook(json) {
  const src = (json && (json.orderbook_fp || json.orderbook)) || json || {};
  const yes = src.yes_dollars || src.yes || [];
  const no = src.no_dollars || src.no || [];
  const book = emptyBook();
  for (const row of yes) {
    if (!Array.isArray(row)) continue;
    pushLevel(book.bids, row[0], row[1]);
  }
  for (const row of no) {
    if (!Array.isArray(row)) continue;
    const noPx = asPrice(row[0]);
    const qty = asQty(row[1]);
    if (noPx == null || qty == null) continue;
    pushLevel(book.asks, roundCent(1 - noPx), qty);
  }
  return sortBook(book);
}

function parseKalshiTrade(trade) {
  if (!trade || typeof trade !== 'object') return null;
  if (trade.is_block_trade === true || trade.isBlockTrade === true) return null;
  const price = asPrice(trade.yes_price_dollars != null ? trade.yes_price_dollars : trade.yes_price);
  const qty = asQty(trade.count_fp != null ? trade.count_fp : (trade.count != null ? trade.count : trade.quantity));
  if (price == null || qty == null) return null;
  const id = trade.trade_id || trade.tradeId || trade.id || null;
  const ts = Date.parse(trade.created_time || trade.createdTime || trade.ts || '') || null;
  return {
    id: id != null ? String(id) : null,
    price,
    qty,
    ts: Number.isFinite(ts) ? ts : null,
    ticker: trade.ticker ? String(trade.ticker).toUpperCase() : null,
  };
}

function levelsFromPoly(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    const price = row.px != null ? row.px : (row.price != null ? row.price : row);
    const size = row.qty != null ? row.qty : (row.quantity != null ? row.quantity : row.size);
    pushLevel(out, price, size);
  }
  return out;
}

function parsePolyBook(json) {
  const src = (json && (json.marketData || json.market_data || json.book)) || json || {};
  const book = emptyBook();
  book.bids = levelsFromPoly(src.bids || src.yesBids || src.yes_bids);
  book.asks = levelsFromPoly(src.offers || src.asks || src.yesAsks || src.yes_asks);
  const stats = src.stats || {};
  const last = asPrice(stats.lastTradePx || stats.last_trade_px || src.lastTradePx);
  const lastQty = asQty(stats.lastTradeQty || stats.last_trade_qty);
  const lastTs = Date.parse(stats.lastTradeSetTime || stats.last_trade_set_time || src.transactTime || '') || null;
  return {
    ...sortBook(book),
    lastTrade: last == null ? null : {
      price: last,
      qty: lastQty,
      ts: Number.isFinite(lastTs) ? lastTs : null,
    },
  };
}

function invertBook(book) {
  const src = book || emptyBook();
  const inv = emptyBook();
  for (const lvl of src.asks || []) pushLevel(inv.bids, roundCent(1 - lvl.price), lvl.size);
  for (const lvl of src.bids || []) pushLevel(inv.asks, roundCent(1 - lvl.price), lvl.size);
  const out = sortBook(inv);
  out.inverted = true;
  if (src.lastTrade && src.lastTrade.price != null) {
    out.lastTrade = {
      price: roundCent(1 - src.lastTrade.price),
      qty: src.lastTrade.qty,
      ts: src.lastTrade.ts,
    };
  }
  return out;
}

function parsePolyTrade(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const trade = msg.trade || msg;
  const price = asPrice(trade.price || trade.px);
  const qty = asQty(trade.quantity || trade.qty || trade.size);
  if (price == null || qty == null) return null;
  const slug = trade.marketSlug || trade.market_slug || trade.slug || null;
  const ts = Date.parse(trade.tradeTime || trade.trade_time || trade.ts || '') || null;
  const id = trade.tradeId || trade.trade_id || trade.id || null;
  return {
    id: id != null ? String(id) : (Number.isFinite(ts) ? `${slug || ''}|${ts}|${price}|${qty}` : null),
    price,
    qty,
    ts: Number.isFinite(ts) ? ts : null,
    slug: slug ? String(slug).toLowerCase() : null,
  };
}

// Markets WS frames (camelCase or snake_case). Returns { book, trade }.
function parsePolyMarketMessage(raw) {
  let msg = raw;
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw); } catch (_) { return null; }
  }
  if (!msg || typeof msg !== 'object') return null;
  const bookSrc = msg.marketData || msg.market_data;
  const tradeSrc = msg.trade;
  const out = { book: null, trade: null };
  if (bookSrc) {
    out.book = parsePolyBook({ marketData: bookSrc });
    const slug = bookSrc.marketSlug || bookSrc.market_slug || null;
    if (slug) out.book.slug = String(slug).toLowerCase();
  }
  if (tradeSrc) out.trade = parsePolyTrade(tradeSrc);
  if (!out.book && !out.trade) return null;
  return out;
}

module.exports = {
  asPrice,
  bookTop,
  sizeAtBid,
  parseKalshiOrderbook,
  parseKalshiTrade,
  parsePolyBook,
  parsePolyTrade,
  parsePolyMarketMessage,
  invertBook,
};
