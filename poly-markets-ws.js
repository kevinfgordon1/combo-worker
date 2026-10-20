// Polymarket US Markets WebSocket (wss://api.polymarket.us/v1/ws/markets)
// with a local order-book cache. poly-worker subscribes the market slugs it
// hedges/prices (SUBSCRIPTION_TYPE_MARKET_DATA, full book snapshots) instead
// of reading /v1/markets/{slug}/book over REST every 10s.
'use strict';
const WebSocket = require('ws');
const { authHeaders, normalizeCred } = require('./polymarket-auth');

const DEFAULT_MARKETS_WS = 'wss://api.polymarket.us/v1/ws/markets';
const SIGN_PATH = '/v1/ws/markets';
const MAX_SLUGS_PER_SUB = 100; // Polymarket: max 100 markets per subscription

function parseMarketsMessage(text) {
  let j = null;
  try { j = JSON.parse(text); } catch (_) { return null; }
  if (!j || typeof j !== 'object') return null;
  const md = j.marketData || j.market_data;
  if (md && (md.marketSlug || md.market_slug)) {
    return { type: 'book', slug: md.marketSlug || md.market_slug, marketData: md };
  }
  if (j.error || j.errorMessage) return { type: 'error', raw: j };
  return { type: 'other', raw: j };
}

function createPolymarketMarketsWs({
  keyId,
  secretKey,
  url = DEFAULT_MARKETS_WS,
  WebSocketImpl = WebSocket,
  onStatus,
  now = () => Date.now(),
  maxSlugs = 500,
} = {}) {
  keyId = normalizeCred(keyId);
  secretKey = normalizeCred(secretKey);
  const slugs = new Set();          // wanted
  const subscribed = new Set();     // sent on the current socket
  const books = new Map();          // slug -> { marketData, at, conn }
  let ws = null;
  let open = false;
  let conn = 0;                     // socket generation; books from older sockets are not "live"
  let closedByUs = true;
  let reconnectTimer = null;
  let pingTimer = null;
  let backoff = 1000;
  let subSeq = 0;
  const stats = { messages: 0, bookMsgs: 0, reconnects: 0, errors: 0 };
  const status = (s, i) => { try { onStatus && onStatus(s, i); } catch (_) {} };

  function sendSubs(list) {
    if (!ws || !open || !list.length) return;
    for (let i = 0; i < list.length; i += MAX_SLUGS_PER_SUB) {
      const chunk = list.slice(i, i + MAX_SLUGS_PER_SUB);
      subSeq += 1;
      try {
        ws.send(JSON.stringify({
          subscribe: {
            requestId: `md-sub-${subSeq}`,
            subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA',
            marketSlugs: chunk,
            responsesDebounced: true,
          },
        }));
        for (const s of chunk) subscribed.add(s);
      } catch (_) { /* resent on reconnect */ }
    }
  }

  function connect() {
    reconnectTimer = null;
    if (closedByUs) return;
    const headers = authHeaders({ keyId, secretKey, method: 'GET', path: SIGN_PATH });
    status('connecting');
    const sock = new WebSocketImpl(url, { headers });
    ws = sock;
    sock.on('open', () => {
      if (ws !== sock) return;
      open = true;
      conn += 1;
      subscribed.clear();
      status('open', { slugs: slugs.size });
      sendSubs([...slugs]);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { sock.ping(); } catch (_) {} }, 10000);
      if (pingTimer.unref) pingTimer.unref();
    });
    sock.on('message', (d) => {
      if (ws !== sock) return;
      stats.messages += 1;
      const m = parseMarketsMessage(d.toString());
      if (!m) return;
      if (m.type === 'book') {
        backoff = 1000;
        stats.bookMsgs += 1;
        books.set(m.slug, { marketData: m.marketData, at: now(), conn });
      } else if (m.type === 'error') {
        stats.errors += 1;
        status('error', { message: JSON.stringify(m.raw).slice(0, 200) });
      }
    });
    sock.on('close', (c) => {
      if (ws !== sock) return;
      open = false;
      clearInterval(pingTimer);
      status('closed', { code: c });
      if (!closedByUs) {
        stats.reconnects += 1;
        const wait = Math.min(backoff, 30000);
        backoff = Math.min(backoff * 2, 30000);
        reconnectTimer = setTimeout(connect, wait);
        if (reconnectTimer.unref) reconnectTimer.unref();
      }
    });
    sock.on('error', (e) => status('error', { message: e && e.message }));
  }

  // Ask for a market's book. Starts the socket on first use.
  function ensure(slug) {
    const s = String(slug || '').trim();
    if (!s) return;
    if (!slugs.has(s)) {
      if (slugs.size >= maxSlugs) return;
      slugs.add(s);
      if (closedByUs) { closedByUs = false; connect(); } else if (open) sendSubs([s]);
    }
  }

  // Book for a slug if it came from the current, open socket (pushes are
  // on-change snapshots, so a book stays valid while the socket is up).
  function liveBook(slug) {
    const b = books.get(String(slug || ''));
    if (!b || !open || b.conn !== conn) return null;
    return b;
  }

  return {
    ensure,
    liveBook,
    get: (slug) => books.get(String(slug || '')) || null,
    isOpen: () => open,
    start() { if (closedByUs) { closedByUs = false; connect(); } },
    stop() {
      closedByUs = true;
      open = false;
      clearInterval(pingTimer);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { ws && ws.close(); } catch (_) {}
    },
    stats: () => ({ ...stats, open, slugs: slugs.size, subscribed: subscribed.size, books: books.size }),
  };
}

module.exports = { createPolymarketMarketsWs, parseMarketsMessage, DEFAULT_MARKETS_WS };
