// Signed Retail HTTP client + optional private WS RFQ subscription.
// Base: https://api.polymarket.us  WS: wss://api.polymarket.us/v1/ws/private
// Do not POST from callers that have POLYMARKET_RFQ_LIVE off — this module
// only transports. Never log key material.
'use strict';
const { Client } = require('undici');
const WebSocket = require('ws');
const {
  authHeaders,
  normalizeCred,
  classifyPolymarketAuthError,
} = require('./polymarket-auth');

const DEFAULT_BASE = 'https://api.polymarket.us';
const DEFAULT_WS = 'wss://api.polymarket.us/v1/ws/private';
const WS_SIGN_PATH = '/v1/ws/private';

function queryString(query) {
  if (!query || typeof query !== 'object') return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

function queryHasKeys(query) {
  if (!query || typeof query !== 'object') return false;
  return Object.entries(query).some(([, v]) => v != null && v !== '');
}

function throwHttpError(method, path, res, extra = {}) {
  const classify = classifyPolymarketAuthError({
    statusCode: res.statusCode,
    json: res.json,
    text: res.text,
  });
  const bits = [`Polymarket ${method} ${path} ${res.statusCode}`];
  if (classify.reason && classify.reason !== 'unauthorized') bits.push(classify.reason);
  if (classify.publicMessage) bits.push(classify.publicMessage);
  if (extra.signMode) bits.push(`sign=${extra.signMode}`);
  const err = new Error(bits.join(' '));
  err.statusCode = res.statusCode;
  err.auth = classify;
  err.signMode = extra.signMode || null;
  throw err;
}

function createPolymarketHttp({
  keyId,
  secretKey,
  baseUrl = DEFAULT_BASE,
  requestFn,
} = {}) {
  const origin = String(baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const accessKey = normalizeCred(keyId);
  const secret = normalizeCred(secretKey);
  const http = requestFn ? null : new Client(origin, {
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
  });
  // Official Retail docs sign pathname only. Some gateways verify RequestURI
  // (path + query). Auto: try pathname, then one path+query retry on 401.
  let signModeLatched = null;
  let querySignTried = false;

  async function requestOnce(method, path, { query, body, ts, signMode = 'path' } = {}) {
    const qs = queryString(query);
    const fullPath = `${path}${qs}`;
    const includeQuery = signMode === 'path+query';
    const signedPath = includeQuery ? fullPath : path;
    const headers = {
      ...authHeaders({
        keyId: accessKey,
        secretKey: secret,
        method,
        path: signedPath,
        ts,
        includeQuery,
      }),
      'Content-Type': 'application/json',
    };
    const payload = body == null ? undefined : JSON.stringify(body);

    if (requestFn) {
      const out = await requestFn({
        method,
        path,
        signPath: signedPath,
        signedPath,
        signMode,
        fullPath,
        headers,
        body,
        payload,
      }) || {};
      return {
        ...out,
        signMode: out.signMode || signMode,
        signedPath: out.signedPath || signedPath,
      };
    }

    const { statusCode, body: resBody } = await http.request({
      path: fullPath,
      method,
      headers,
      body: payload,
    });
    const text = await resBody.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch (_) { json = null; }
    }
    return { statusCode, text, json, signMode, signedPath };
  }

  async function request(method, path, { query, body, ts, signMode } = {}) {
    const mode = signMode || signModeLatched || 'path';
    const res = await requestOnce(method, path, { query, body, ts, signMode: mode });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (!signModeLatched) signModeLatched = mode;
      return res;
    }
    if (
      res.statusCode === 401
      && queryHasKeys(query)
      && !signMode
      && signModeLatched !== 'path+query'
      && mode === 'path'
      && !querySignTried
    ) {
      querySignTried = true;
      const retry = await requestOnce(method, path, {
        query, body, ts, signMode: 'path+query',
      });
      if (retry.statusCode >= 200 && retry.statusCode < 300) {
        signModeLatched = 'path+query';
        return retry;
      }
    }
    return res;
  }

  async function getJson(path, query) {
    const res = await request('GET', path, { query });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throwHttpError('GET', path, res, { signMode: res.signMode || signModeLatched || 'path' });
    }
    return res.json;
  }

  return {
    request,
    getUserId: () => getJson('/v1/rfqs/user-id'),
    listRfqs: (query) => getJson('/v1/rfqs', query),
    listQuotes: (query) => getJson('/v1/rfqs/quotes', query),
    getCombo: (symbol) => getJson('/v1/combos', { symbol }),
    getMarketBySlug: async (slug) => {
      const path = `/v1/market/slug/${encodeURIComponent(slug)}`;
      const res = await request('GET', path);
      if (res.statusCode === 404) return null;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throwHttpError('GET', path, res, { signMode: res.signMode });
      }
      const j = res.json;
      return (j && j.market) || j;
    },
    async createQuote(body) {
      const res = await request('POST', '/v1/rfqs/quotes', { body });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throwHttpError('POST', '/v1/rfqs/quotes', res, { signMode: res.signMode });
      }
      return res.json;
    },
    async confirmQuote(rfqId, quoteId) {
      const path = `/v1/rfqs/${rfqId}/quotes/${quoteId}/confirm`;
      const res = await request('PUT', path, { body: {} });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throwHttpError('PUT', path, res, { signMode: res.signMode });
      }
      return res.json;
    },
    async deleteQuote(rfqId, quoteId) {
      const path = `/v1/rfqs/${rfqId}/quotes/${quoteId}`;
      const res = await request('DELETE', path);
      if (res.statusCode === 404) return { statusCode: 404 };
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throwHttpError('DELETE', path, res, { signMode: res.signMode });
      }
      return { statusCode: res.statusCode, json: res.json };
    },
    getSignMode: () => signModeLatched,
    close() {
      if (http) {
        try { http.close(); } catch (_) {}
      }
    },
  };
}

function rfqFromEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.rfq && typeof obj.rfq === 'object') return obj.rfq;
  return obj;
}

function quoteFromEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.quote && typeof obj.quote === 'object') return obj.quote;
  // Do not treat a bare RFQ (rfqClosed/rfqCreated) as a quote. Quote
  // payloads have rfqId / buyPrice / QUOTE_STATUS_* .
  if (obj.rfq && typeof obj.rfq === 'object' && obj.buyPrice == null && !obj.rfqId) {
    return null;
  }
  if (obj.status && /^RFQ_STATUS_/i.test(String(obj.status)) && !obj.rfqId && obj.buyPrice == null) {
    return null;
  }
  if (obj.rfqId || obj.rfq_id || obj.buyPrice != null || obj.sellPrice != null) return obj;
  if (obj.status && /^QUOTE_STATUS_/i.test(String(obj.status))) return obj;
  return null;
}

function parsePrivateMessage(raw) {
  let msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
  if (!msg || typeof msg !== 'object') return null;

  const ev = msg.rfqEvent && typeof msg.rfqEvent === 'object' ? msg.rfqEvent : msg;
  const variants = [
    'rfqCreated', 'rfqClosed',
    'quoteCreated', 'quoteDeleted', 'quoteAccepted', 'quoteConfirmed', 'quoteExecuted',
  ];
  for (const type of variants) {
    if (ev[type]) {
      const payload = ev[type];
      return {
        type,
        rfq: rfqFromEvent(payload),
        quote: quoteFromEvent(payload),
        raw: msg,
      };
    }
  }

  const order = msg.orderSubscriptionUpdate && msg.orderSubscriptionUpdate.execution;
  if (order) {
    return { type: 'orderExecution', execution: order, raw: msg };
  }
  return { type: 'other', raw: msg };
}

function createPolymarketRfqWs({
  keyId,
  secretKey,
  url = DEFAULT_WS,
  onEvent,
  onStatus,
  subscribeOrders = false,
} = {}) {
  keyId = normalizeCred(keyId);
  secretKey = normalizeCred(secretKey);
  let ws = null;
  let pingTimer = null;
  let backoff = 1000;
  let closedByUs = false;
  const status = (s, i) => { try { onStatus && onStatus(s, i); } catch (_) {} };

  function sendSubscribe() {
    const reqs = [
      { subscribe: { requestId: 'rfq-sub-1', subscriptionType: 'SUBSCRIPTION_TYPE_RFQ' } },
    ];
    if (subscribeOrders) {
      reqs.push({
        subscribe: {
          requestId: 'order-sub-1',
          subscriptionType: 'SUBSCRIPTION_TYPE_ORDER',
          marketSlugs: [],
        },
      });
    }
    for (const body of reqs) {
      try { ws.send(JSON.stringify(body)); } catch (_) {}
    }
  }

  function connect() {
    const headers = authHeaders({
      keyId, secretKey, method: 'GET', path: WS_SIGN_PATH,
    });
    status('connecting', { url });
    ws = new WebSocket(url, { headers });

    ws.on('open', () => {
      backoff = 1000;
      sendSubscribe();
      status('subscribed');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.ping(); } catch (_) {} }, 10000);
    });

    ws.on('message', (d) => {
      const parsed = parsePrivateMessage(d.toString());
      if (!parsed) return;
      try { onEvent && onEvent(parsed); } catch (e) { console.error('[POLY] ws event', e && e.message); }
    });

    ws.on('close', (c) => {
      clearInterval(pingTimer);
      status('closed', { code: c });
      if (!closedByUs) reconnect();
    });
    ws.on('error', (e) => status('error', { message: e && e.message }));
  }

  function reconnect() {
    const wait = Math.min(backoff, 30000);
    status('reconnecting', { wait });
    setTimeout(() => { backoff *= 2; connect(); }, wait);
  }

  return {
    start() { closedByUs = false; connect(); },
    stop() {
      closedByUs = true;
      clearInterval(pingTimer);
      try { ws && ws.close(); } catch (_) {}
    },
  };
}

module.exports = {
  DEFAULT_BASE,
  DEFAULT_WS,
  queryString,
  createPolymarketHttp,
  createPolymarketRfqWs,
  parsePrivateMessage,
};
