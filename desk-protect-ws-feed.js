// Polymarket US market-data websocket for Bet Protect.
// Book snapshots (SUBSCRIPTION_TYPE_MARKET_DATA) plus prints
// (SUBSCRIPTION_TYPE_TRADE). Optional private order socket updates our
// leaves. This process already holds the Retail keys on kaygo-poly-worker.
'use strict';

const WebSocket = require('ws');
const { authHeaders, normalizeCred } = require('./polymarket-auth');
const { amountValue } = require('./desk-protect-ws-decide');

const MARKETS_WS = 'wss://api.polymarket.us/v1/ws/markets';
const PRIVATE_WS = 'wss://api.polymarket.us/v1/ws/private';
const MARKETS_PATH = '/v1/ws/markets';
const PRIVATE_PATH = '/v1/ws/private';
const MAX_SLUGS_PER_SUB = 100;

function parseJson(raw) {
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
    return msg && typeof msg === 'object' ? msg : null;
  } catch (_) {
    return null;
  }
}

function slugOf(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.marketSlug || obj.market_slug || obj.slug || '').trim();
}

function parseBookFrame(msg) {
  const book = msg.marketData || msg.market_data
    || (msg.data && typeof msg.data === 'object' && (msg.data.marketData || msg.data.market_data));
  if (!book || typeof book !== 'object') return null;
  const slug = slugOf(book) || slugOf(msg);
  if (!slug) return null;
  if (!((book.bids && book.bids.length) || (book.offers && book.offers.length) || (book.asks && book.asks.length))) {
    return null;
  }
  return {
    slug,
    bids: book.bids || [],
    offers: book.offers || book.asks || [],
    stats: book.stats || null,
    transactTime: book.transactTime || book.transact_time || book.timestamp || null,
  };
}

function parseTradeFrame(msg) {
  const trade = msg.trade || msg.marketTrade || msg.market_trade;
  if (!trade || typeof trade !== 'object') return null;
  const price = amountValue(trade.price != null ? trade.price : (trade.px != null ? trade.px : trade.lastTradePx));
  if (!(price > 0 && price < 1)) return null;
  const slug = slugOf(trade) || slugOf(msg);
  if (!slug) return null;
  const ts = Date.parse(trade.tradeTime || trade.trade_time || trade.transactTime || trade.ts || '');
  const id = trade.tradeId || trade.trade_id || trade.id || null;
  const orderId = (trade.order && (trade.order.id || trade.order.order_id))
    || trade.orderId || trade.order_id || null;
  const qty = Number(trade.quantity != null ? trade.quantity : (trade.qty != null ? trade.qty : trade.size));
  return {
    slug,
    price,
    qty: Number.isFinite(qty) ? qty : null,
    ts: Number.isFinite(ts) ? ts : null,
    id: id != null ? String(id) : null,
    orderId: orderId != null ? String(orderId) : '',
  };
}

function parseMarketFrame(raw) {
  const msg = parseJson(raw);
  if (!msg) return null;
  const book = parseBookFrame(msg);
  const trade = parseTradeFrame(msg);
  if (!book && !trade) return null;
  return { book, trade };
}

function bookSideFromOrder(order) {
  const side = String(order.side || order.orderSide || '').toUpperCase();
  if (side.includes('SELL')) return 'sell';
  if (side.includes('BUY')) return 'buy';
  const intent = String(order.intent || '').toUpperCase();
  if (intent.includes('BUY_SHORT') || intent.includes('SELL_LONG')) return 'sell';
  if (intent.includes('SELL_SHORT') || intent.includes('BUY_LONG') || intent.includes('BUY')) return 'buy';
  return '';
}

function parseOpenOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const id = String(order.id || order.orderId || order.order_id || '').trim();
  if (!id) return null;
  const slug = slugOf(order) || slugOf(order.marketMetadata);
  const yes = amountValue(order.price);
  const leavesRaw = order.leavesQuantity != null && order.leavesQuantity !== ''
    ? order.leavesQuantity
    : order.leaves_quantity;
  const leaves = leavesRaw != null && leavesRaw !== '' ? Number(leavesRaw) : Number(order.quantity);
  const state = String(order.state || '');
  const gone = /FILLED|CANCEL|REJECT|EXPIRED|REPLACED/i.test(state) && !/PARTIAL/i.test(state);
  return {
    id,
    marketSlug: slug,
    yesPrice: yes,
    leaves: Number.isFinite(leaves) && leaves > 0 && !gone ? leaves : 0,
    bookSide: bookSideFromOrder(order),
    gone,
  };
}

function ordersFromPayload(payload) {
  const raw = payload && (payload.orders || payload);
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const order of list) {
    const parsed = parseOpenOrder(order);
    if (parsed) out.push(parsed);
  }
  return out;
}

function executionsFromFrame(msg) {
  if (!msg || typeof msg !== 'object') return [];
  const update = msg.orderSubscriptionUpdate
    || msg.order_subscription_update
    || msg.executionReport
    || msg.execution_report
    || null;
  const bag = update || msg;
  if (Array.isArray(bag.executions)) return bag.executions.filter((row) => row && typeof row === 'object');
  if (bag.execution && typeof bag.execution === 'object') return [bag.execution];
  if (bag.order && (bag.lastShares != null || bag.last_shares != null || bag.type != null)) return [bag];
  return [];
}

function executionOrderId(exec) {
  const order = exec && (exec.order || exec);
  if (!order || typeof order !== 'object') return '';
  return String(order.id || order.orderId || order.order_id || '').trim();
}

function createMarketFeed({
  keyId,
  secretKey,
  WebSocketImpl = WebSocket,
  headersFor,
  marketsUrl = MARKETS_WS,
  privateUrl = PRIVATE_WS,
  onBook,
  onTrade,
  onOrders,
  onExecution,
  onStatus,
  now = () => Date.now(),
  connectPrivate = true,
} = {}) {
  keyId = normalizeCred(keyId);
  secretKey = normalizeCred(secretKey);
  const slugs = new Set();
  let ws = null;
  let privateWs = null;
  let open = false;
  let privateOpen = false;
  let closedByUs = true;
  let reconnectTimer = null;
  let privateTimer = null;
  let pingTimer = null;
  let backoff = 1000;
  let privateBackoff = 1000;
  let lastMessageAt = 0;
  let lastPongAt = 0;
  let everOpened = false;
  const status = (s, info) => { try { onStatus && onStatus(s, info); } catch (_) {} };

  function headers(path) {
    if (headersFor) return headersFor(path);
    return authHeaders({ keyId, secretKey, method: 'GET', path });
  }

  function sendSubs() {
    if (!ws || !open || !slugs.size) return;
    const list = [...slugs];
    let seq = 0;
    for (let i = 0; i < list.length; i += MAX_SLUGS_PER_SUB) {
      const chunk = list.slice(i, i + MAX_SLUGS_PER_SUB);
      seq += 1;
      for (const type of ['SUBSCRIPTION_TYPE_MARKET_DATA', 'SUBSCRIPTION_TYPE_TRADE']) {
        try {
          ws.send(JSON.stringify({
            subscribe: {
              requestId: `protect-${type}-${seq}`,
              subscriptionType: type,
              marketSlugs: chunk,
            },
          }));
        } catch (_) { /* resent on reconnect */ }
      }
    }
  }

  function connect() {
    reconnectTimer = null;
    if (closedByUs) return;
    status('connecting');
    const sock = new WebSocketImpl(marketsUrl, { headers: headers(MARKETS_PATH) });
    ws = sock;
    sock.on('open', () => {
      if (ws !== sock) return;
      open = true;
      everOpened = true;
      lastPongAt = now();
      backoff = 1000;
      status('open', { slugs: slugs.size });
      sendSubs();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { sock.ping(); } catch (_) {} }, 10000);
      if (pingTimer.unref) pingTimer.unref();
    });
    sock.on('pong', () => {
      if (ws !== sock) return;
      lastPongAt = now();
    });
    sock.on('message', (buf) => {
      if (ws !== sock) return;
      lastMessageAt = now();
      const parsed = parseMarketFrame(buf);
      if (!parsed) return;
      if (parsed.book) {
        try { onBook && onBook(parsed.book, lastMessageAt); } catch (_) {}
      }
      if (parsed.trade) {
        try { onTrade && onTrade(parsed.trade, lastMessageAt); } catch (_) {}
      }
    });
    sock.on('close', () => {
      if (ws !== sock) return;
      open = false;
      clearInterval(pingTimer);
      status('closed');
      if (!closedByUs) {
        const wait = Math.min(backoff, 30000);
        backoff = Math.min(backoff * 2, 30000);
        reconnectTimer = setTimeout(connect, wait);
        if (reconnectTimer.unref) reconnectTimer.unref();
      }
    });
    sock.on('error', (err) => status('error', { message: err && err.message }));
  }

  function connectOrders() {
    privateTimer = null;
    if (closedByUs || connectPrivate === false || !keyId) return;
    const sock = new WebSocketImpl(privateUrl, { headers: headers(PRIVATE_PATH) });
    privateWs = sock;
    sock.on('open', () => {
      if (privateWs !== sock) return;
      privateOpen = true;
      privateBackoff = 1000;
      try {
        sock.send(JSON.stringify({
          subscribe: {
            requestId: 'protect-orders',
            subscriptionType: 'SUBSCRIPTION_TYPE_ORDER',
            marketSlugs: [],
          },
        }));
      } catch (_) {}
    });
    sock.on('message', (buf) => {
      if (privateWs !== sock) return;
      const msg = parseJson(buf);
      if (!msg) return;
      const execs = executionsFromFrame(msg);
      for (const exec of execs) {
        const id = executionOrderId(exec);
        if (!id) continue;
        const shares = Number(exec.lastShares != null ? exec.lastShares : exec.last_shares);
        try { onExecution && onExecution({ orderId: id, lastShares: Number.isFinite(shares) ? shares : null }); } catch (_) {}
      }
      const snapshot = msg.orders || (msg.order && !execs.length ? [msg.order] : null);
      if (snapshot) {
        try { onOrders && onOrders(ordersFromPayload({ orders: snapshot }), { full: Array.isArray(msg.orders) }); } catch (_) {}
      }
    });
    sock.on('close', () => {
      if (privateWs !== sock) return;
      privateOpen = false;
      if (!closedByUs) {
        const wait = Math.min(privateBackoff, 30000);
        privateBackoff = Math.min(privateBackoff * 2, 30000);
        privateTimer = setTimeout(connectOrders, wait);
        if (privateTimer.unref) privateTimer.unref();
      }
    });
    sock.on('error', () => {});
  }

  return {
    setSlugs(next) {
      slugs.clear();
      for (const slug of next || []) {
        const s = String(slug || '').trim();
        if (s) slugs.add(s);
      }
      if (closedByUs) {
        closedByUs = false;
        connect();
        connectOrders();
      } else if (open) sendSubs();
    },
    stop() {
      closedByUs = true;
      open = false;
      privateOpen = false;
      clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (privateTimer) clearTimeout(privateTimer);
      reconnectTimer = null;
      privateTimer = null;
      try { ws && ws.close(); } catch (_) {}
      try { privateWs && privateWs.close(); } catch (_) {}
    },
    stats() {
      return {
        open,
        privateOpen,
        everOpened,
        slugs: slugs.size,
        lastMessageAt: lastMessageAt || 0,
        lastPongAt: lastPongAt || 0,
      };
    },
  };
}

module.exports = {
  MARKETS_WS,
  PRIVATE_WS,
  parseMarketFrame,
  parseOpenOrder,
  ordersFromPayload,
  executionsFromFrame,
  executionOrderId,
  createMarketFeed,
};
