// Read-only venue access for paper mode.
//
// Kalshi: public GET on the same host the odds relay uses
//   (https://api.elections.kalshi.com). Markets, order books, and trades only.
//   The Combo Locks API key is not read and no Kalshi websocket is opened.
//   A caller may inject the existing kalshi-http client for a signed GET;
//   that path still refuses anything except GET /markets.
// Polymarket US: existing createPolymarketHttp GET (market by slug) and the
//   public gateway book. Optional markets websocket (/v1/ws/markets), which
//   is not the private RFQ socket. No order POST.
'use strict';

const WebSocket = require('ws');
const { createKalshiClient } = require('./kalshi-http');
const { signedRequest } = require('./kalshi-auth');
const { createPolymarketHttp } = require('./polymarket-client');
const { authHeaders } = require('./polymarket-auth');
const { polySlugCandidates } = require('./mm-paper-games');
const {
  parseKalshiOrderbook,
  parseKalshiTrade,
  parsePolyBook,
  parsePolyMarketMessage,
  invertBook,
} = require('./mm-paper-books');

const SERIES = {
  nfl: 'KXNFLGAME',
  mlb: 'KXMLBGAME',
  ncaaf: 'KXNCAAFGAME',
};

const POLY_GATEWAY = 'https://gateway.polymarket.us';
const POLY_MARKETS_WS = 'wss://api.polymarket.us/v1/ws/markets';
const KALSHI_PUBLIC_ORIGIN = 'https://api.elections.kalshi.com';

function assertPaperReadOnly(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');
  if (m !== 'GET') {
    throw new Error(`mm-paper refuses ${m || 'non-GET'} ${p}`);
  }
  if (/\/orders|\/rfqs|\/communications\/quotes|\/portfolio/i.test(p)) {
    throw new Error(`mm-paper refuses trading path ${p}`);
  }
  const kalshiOk = /^\/trade-api\/v2\/markets(\/|$)/.test(p);
  const polyOk = /^\/v1\/markets(\/|$)/.test(p) || /^\/v1\/market\//.test(p);
  if (!kalshiOk && !polyOk) {
    throw new Error(`mm-paper refuses path ${p}`);
  }
}

function createKalshiReader({ keyId, pem, client, fetchFn, base } = {}) {
  const useSigned = !!(client || (keyId && pem));
  if (useSigned) {
    const http = client || createKalshiClient();
    const owned = !client;
    async function get(signPath, query) {
      assertPaperReadOnly('GET', signPath);
      const qs = query ? `?${query}` : '';
      const res = await signedRequest(async ({ method, path, headers }) => {
        const { statusCode, headers: resHeaders, body } = await http.request({
          method, path, headers,
        });
        const text = await body.text();
        return { statusCode, headers: resHeaders, text };
      }, {
        keyId,
        pem,
        method: 'GET',
        signPath,
        path: `${signPath}${qs}`,
      });
      let json = null;
      if (res && res.text) {
        try { json = JSON.parse(res.text); } catch (_) { json = null; }
      }
      return { statusCode: res && res.statusCode, json };
    }
    return {
      get,
      signed: true,
      close() {
        if (owned) {
          try { http.close(); } catch (_) { /* ignore */ }
        }
      },
    };
  }

  const origin = String(base || KALSHI_PUBLIC_ORIGIN).replace(/\/$/, '');
  const fetchImpl = fetchFn || fetch;
  async function get(signPath, query) {
    assertPaperReadOnly('GET', signPath);
    const qs = query ? `?${query}` : '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchImpl(`${origin}${signPath}${qs}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch (_) { json = null; }
      }
      return { statusCode: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    get,
    signed: false,
    close() {},
  };
}

async function listKalshiMarkets(reader, leagues) {
  if (!reader) return [];
  const markets = [];
  for (const league of leagues || []) {
    const series = SERIES[league];
    if (!series) continue;
    let cursor = '';
    for (let page = 0; page < 6; page += 1) {
      const qs = new URLSearchParams({
        series_ticker: series,
        status: 'open',
        limit: '200',
      });
      if (cursor) qs.set('cursor', cursor);
      const { json } = await reader.get('/trade-api/v2/markets', qs.toString());
      const batch = (json && json.markets) || [];
      markets.push(...batch);
      cursor = (json && json.cursor) || '';
      if (!cursor || !batch.length) break;
    }
  }
  return markets;
}

async function kalshiBook(reader, ticker) {
  if (!reader || !ticker) return null;
  const path = `/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`;
  const { json } = await reader.get(path);
  if (!json) return null;
  return parseKalshiOrderbook(json);
}

async function kalshiTrades(reader, ticker, minTs) {
  if (!reader || !ticker) return [];
  const qs = new URLSearchParams({ ticker: String(ticker), limit: '100' });
  if (minTs) qs.set('min_ts', String(Math.floor(minTs / 1000)));
  const { json } = await reader.get('/trade-api/v2/markets/trades', qs.toString());
  return ((json && json.trades) || []).map(parseKalshiTrade).filter(Boolean);
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function createPolyReader({ keyId, secretKey, http } = {}) {
  const client = http || (keyId && secretKey ? createPolymarketHttp({ keyId, secretKey }) : null);
  return {
    client,
    async market(slug) {
      if (client && client.getMarketBySlug) {
        try {
          const found = await client.getMarketBySlug(slug);
          if (found) return found;
        } catch (_) { /* gateway fallback */ }
      }
      const body = await fetchJson(`${POLY_GATEWAY}/v1/market/slug/${encodeURIComponent(slug)}`);
      return (body && body.market) || body;
    },
    async book(slug) {
      if (client && client.request) {
        const path = `/v1/markets/${encodeURIComponent(slug)}/book`;
        assertPaperReadOnly('GET', path);
        try {
          const res = await client.request('GET', path);
          if (res && res.statusCode >= 200 && res.statusCode < 300 && res.json) {
            return parsePolyBook(res.json);
          }
        } catch (_) { /* gateway fallback */ }
      }
      const body = await fetchJson(`${POLY_GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`);
      return body ? parsePolyBook(body) : null;
    },
    close() {
      if (client && client.close && client !== http) {
        try { client.close(); } catch (_) { /* ignore */ }
      }
    },
  };
}

function createPolyMarketsWs({ keyId, secretKey, onBook, onTrade, onStatus } = {}) {
  if (!keyId || !secretKey) return { start() {}, stop() {}, update() {} };
  let ws = null;
  let closed = false;
  let slugs = [];
  let backoff = 1000;
  let timer = null;

  function sendSubs() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !slugs.length) return;
    const body = (type, id) => ({
      subscribe: {
        requestId: id,
        subscriptionType: type,
        marketSlugs: slugs,
      },
    });
    try {
      ws.send(JSON.stringify(body('SUBSCRIPTION_TYPE_MARKET_DATA', 'mm-paper-book')));
      ws.send(JSON.stringify(body('SUBSCRIPTION_TYPE_TRADE', 'mm-paper-trade')));
    } catch (_) { /* reconnect will retry */ }
  }

  function connect() {
    if (closed) return;
    const headers = authHeaders({
      keyId, secretKey, method: 'GET', path: '/v1/ws/markets',
    });
    if (onStatus) onStatus('connecting');
    ws = new WebSocket(POLY_MARKETS_WS, { headers });
    ws.on('open', () => {
      backoff = 1000;
      if (onStatus) onStatus('open');
      sendSubs();
    });
    ws.on('message', (buf) => {
      const parsed = parsePolyMarketMessage(buf.toString());
      if (!parsed) return;
      if (parsed.book && onBook) onBook(parsed.book);
      if (parsed.trade && onTrade) onTrade(parsed.trade);
    });
    ws.on('close', () => {
      if (closed) return;
      if (onStatus) onStatus('closed');
      timer = setTimeout(connect, Math.min(backoff, 30000));
      backoff *= 2;
    });
    ws.on('error', (err) => {
      if (onStatus) onStatus(`error ${err && err.message ? err.message : ''}`.trim());
    });
  }

  return {
    start() { closed = false; connect(); },
    stop() {
      closed = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (_) { /* ignore */ }
    },
    update(next) {
      slugs = [...new Set((next || []).filter(Boolean))].slice(0, 80);
      sendSubs();
    },
  };
}

async function resolvePolyBooks(reader, game) {
  const slugs = polySlugCandidates(game);
  for (const slug of slugs) {
    const market = await reader.market(slug);
    if (!market) continue;
    const book = await reader.book(slug);
    if (!book) continue;
    return { slug, market, book };
  }
  return null;
}

module.exports = {
  SERIES,
  KALSHI_PUBLIC_ORIGIN,
  assertPaperReadOnly,
  createKalshiReader,
  listKalshiMarkets,
  kalshiBook,
  kalshiTrades,
  createPolyReader,
  createPolyMarketsWs,
  resolvePolyBooks,
};
