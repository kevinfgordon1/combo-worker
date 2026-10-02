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
  if (res.localBackoff) { err.localBackoff = true; err.retryInMs = res.retryInMs; }
  if (res.backoffMs) err.backoffMs = res.backoffMs;
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

  // GET-only 429 circuit breaker, keyed by path. Cloudflare error 1015 (rate
  // limited) used to be retried on the next 3s poll, which keeps the ban
  // alive. After a 429 we skip GETs to that path for a jittered, exponentially
  // growing window (honoring Retry-After). Writes (POST/PUT/DELETE: quote,
  // confirm, delete) are NEVER blocked here.
  const getBackoff = new Map(); // path -> { until, step, hits, last }
  const BACKOFF_BASE_MS = Number(process.env.POLY_429_BASE_MS) || 5000;
  const BACKOFF_MAX_MS = Number(process.env.POLY_429_MAX_MS) || 120000;
  const nowMs = () => Date.now();

  function backoffFor(path) {
    let b = getBackoff.get(path);
    if (!b) { b = { until: 0, step: 0, hits: 0, skipped: 0, last: 0 }; getBackoff.set(path, b); }
    return b;
  }

  function note429(path, res) {
    const b = backoffFor(path);
    b.hits += 1;
    b.step = Math.min(b.step + 1, 10);
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** (b.step - 1)));
    const ra = Number(res && res.headers && (res.headers['retry-after'] || res.headers['Retry-After']));
    const base = Number.isFinite(ra) && ra > 0 ? Math.min(BACKOFF_MAX_MS, ra * 1000) : exp;
    const wait = Math.round(base * (0.75 + Math.random() * 0.5)); // +/-25% jitter
    b.until = nowMs() + wait;
    b.last = nowMs();
    return wait;
  }

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

    const { statusCode, headers: resHeaders, body: resBody } = await http.request({
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
    return { statusCode, text, json, signMode, signedPath, headers: resHeaders };
  }

  async function request(method, path, { query, body, ts, signMode } = {}) {
    const isGet = method === 'GET';
    if (isGet) {
      const b = getBackoff.get(path);
      if (b && b.until > nowMs()) {
        b.skipped += 1;
        // Synthetic 429: no network call, so we stop feeding the rate limiter.
        return {
          statusCode: 429,
          text: 'local backoff after upstream 429',
          json: null,
          signMode: signMode || signModeLatched || 'path',
          localBackoff: true,
          retryInMs: b.until - nowMs(),
        };
      }
    }
    const mode = signMode || signModeLatched || 'path';
    const res = await requestOnce(method, path, { query, body, ts, signMode: mode });
    if (isGet) {
      if (res.statusCode === 429) {
        const wait = note429(path, res);
        res.backoffMs = wait;
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        const b = getBackoff.get(path);
        if (b && b.step) { b.step = 0; b.until = 0; }
      }
    }
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

  function backoffSnapshot() {
    const out = {};
    const t = nowMs();
    for (const [path, b] of getBackoff) {
      out[path] = { hits: b.hits, skipped: b.skipped, blockedMs: Math.max(0, b.until - t), step: b.step };
    }
    return out;
  }

  // True when any GET on `path` is currently inside a 429 backoff window.
  function isBackedOff(path) {
    const b = getBackoff.get(path);
    return !!(b && b.until > nowMs());
  }

  return {
    request,
    backoffSnapshot,
    isBackedOff,
    getUserId: () => getJson('/v1/rfqs/user-id'),
    listRfqs: (query) => getJson('/v1/rfqs', query),
    listQuotes: (query) => getJson('/v1/rfqs/quotes', query),
    getCombo: (symbol) => getJson('/v1/combos', { symbol }),
    async getOrder(orderId) {
      if (orderId == null || orderId === '') return null;
      const path = `/v1/order/${encodeURIComponent(orderId)}`;
      const res = await request('GET', path);
      if (res.statusCode === 404) return null;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throwHttpError('GET', path, res, { signMode: res.signMode || signModeLatched || 'path' });
      }
      const j = res.json;
      return (j && j.order) || j;
    },
    listPositions: (query) => getJson('/v1/portfolio/positions', query),
    listActivities: (query) => getJson('/v1/portfolio/activities', query),
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

  let executions = executionsFromOrderUpdate(orderUpdateFromMessage(msg));
  if (!executions.length) executions = executionsFromOrderUpdate(msg);
  if (executions.length) {
    return {
      type: 'orderExecution',
      execution: executions[0],
      executions,
      raw: msg,
    };
  }
  return { type: 'other', raw: msg };
}

// Retail private WS docs use snake_case + protobuf numeric enums.
// RFQ events on the same socket are camelCase. Accept both. Also accept
// a bare execution / drop-copy wrapper so a missed ORDER subscription
// shape cannot silently drop a fill.
function looksLikeExecution(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return obj.type != null
    || obj.lastShares != null || obj.last_shares != null
    || obj.executionId != null || obj.execution_id != null
    || obj.tradeId != null || obj.trade_id != null
    || (obj.order && typeof obj.order === 'object');
}

function orderUpdateFromMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  return msg.orderSubscriptionUpdate
    || msg.order_subscription_update
    || msg.dropCopy
    || msg.drop_copy
    || msg.executionReport
    || msg.execution_report
    || null;
}

function executionsFromOrderUpdate(update) {
  if (!update || typeof update !== 'object') return [];
  if (Array.isArray(update.executions)) {
    return update.executions.filter((x) => x && typeof x === 'object');
  }
  if (update.execution && typeof update.execution === 'object') {
    return [update.execution];
  }
  if (update.update && typeof update.update === 'object') {
    return executionsFromOrderUpdate(update.update);
  }
  if (looksLikeExecution(update) && (update.type != null || update.order)) {
    return [update];
  }
  return [];
}

const DEFAULT_WS_STALL_MS = 60000;
const DEFAULT_WS_STALL_CHECK_MS = 5000;
function envStallMs() {
  const raw = process.env.POLY_WS_STALL_MS;
  if (raw == null || raw === '') return DEFAULT_WS_STALL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WS_STALL_MS;
}

function createPolymarketRfqWs({
  keyId,
  secretKey,
  url = DEFAULT_WS,
  onEvent,
  onStatus,
  onStall,
  onRecovered,
  subscribeOrders = false,
  // Silent-stall watchdog: the RFQ firehose normally delivers tens of
  // messages/s. A socket that stays "open" (pings still answered) but delivers
  // nothing for stallMs is dead; terminate it so the close handler reconnects.
  // 0 disables.
  stallMs = envStallMs(),
  stallCheckMs = DEFAULT_WS_STALL_CHECK_MS,
  WebSocketImpl = WebSocket,
  now = () => Date.now(),
} = {}) {
  keyId = normalizeCred(keyId);
  secretKey = normalizeCred(secretKey);
  let ws = null;
  let pingTimer = null;
  let stallTimer = null;
  let reconnectTimer = null;
  let backoff = 1000;
  let closedByUs = false;
  let lastMessageAt = 0;
  let connectedAt = 0;
  let stalls = 0;
  let reconnects = 0;
  let stalledPending = false; // a stall was declared; waiting for traffic to resume
  const status = (s, i) => { try { onStatus && onStatus(s, i); } catch (_) {} };

  function sendSubscribe() {
    const reqs = [
      { subscribe: { requestId: 'rfq-sub-1', subscriptionType: 'SUBSCRIPTION_TYPE_RFQ' } },
    ];
    if (subscribeOrders) {
      reqs.push({
        subscribe: {
          requestId: 'order-sub-1',
          request_id: 'order-sub-1',
          subscriptionType: 'SUBSCRIPTION_TYPE_ORDER',
          subscription_type: 1,
          marketSlugs: [],
          market_slugs: [],
        },
      });
    }
    for (const body of reqs) {
      try { ws.send(JSON.stringify(body)); } catch (_) {}
    }
  }

  function checkStall() {
    if (closedByUs || !ws || !(stallMs > 0)) return;
    const t = now();
    const ref = lastMessageAt || connectedAt;
    const silentMs = t - ref;
    if (silentMs < stallMs) return;
    stalls += 1;
    stalledPending = true;
    const info = { silentMs, stalls, reconnects, lastMessageAt: lastMessageAt || null };
    status('stalled', { message: `no ws message for ${Math.round(silentMs / 1000)}s - reconnecting` });
    try { onStall && onStall(info); } catch (_) {}
    // Reset the clock so a socket that stays dead after reconnect is re-flagged
    // after another full window rather than every check tick.
    lastMessageAt = 0;
    connectedAt = t;
    try { ws.terminate(); } catch (_) {}
  }

  function connect() {
    reconnectTimer = null;
    const headers = authHeaders({
      keyId, secretKey, method: 'GET', path: WS_SIGN_PATH,
    });
    status('connecting', { url });
    connectedAt = now();
    lastMessageAt = 0;
    const sock = new WebSocketImpl(url, { headers });
    ws = sock;

    sock.on('open', () => {
      if (ws !== sock) return;
      backoff = 1000;
      connectedAt = now();
      sendSubscribe();
      status('subscribed');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { sock.ping(); } catch (_) {} }, 10000);
      clearInterval(stallTimer);
      if (stallMs > 0) {
        stallTimer = setInterval(checkStall, stallCheckMs);
        if (stallTimer.unref) stallTimer.unref();
      }
    });

    sock.on('message', (d) => {
      if (ws !== sock) return;
      lastMessageAt = now();
      if (stalledPending) {
        stalledPending = false;
        try { onRecovered && onRecovered({ stalls, reconnects }); } catch (_) {}
        status('recovered');
      }
      const parsed = parsePrivateMessage(d.toString());
      if (!parsed) return;
      try { onEvent && onEvent(parsed); } catch (e) { console.error('[POLY] ws event', e && e.message); }
    });

    sock.on('close', (c) => {
      if (ws !== sock) return; // superseded socket
      clearInterval(pingTimer);
      clearInterval(stallTimer);
      status('closed', { code: c });
      if (!closedByUs) reconnect();
    });
    sock.on('error', (e) => status('error', { message: e && e.message }));
  }

  function reconnect() {
    if (reconnectTimer) return;
    const wait = Math.min(backoff, 30000);
    status('reconnecting', { wait });
    reconnects += 1;
    reconnectTimer = setTimeout(() => { backoff = Math.min(backoff * 2, 30000); connect(); }, wait);
  }

  return {
    start() { closedByUs = false; connect(); },
    stop() {
      closedByUs = true;
      clearInterval(pingTimer);
      clearInterval(stallTimer);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { ws && ws.close(); } catch (_) {}
    },
    // Exposed for tests/heartbeat: run one watchdog pass.
    checkStall,
    stats() {
      return { lastMessageAt: lastMessageAt || null, stalls, reconnects, silentMs: lastMessageAt ? now() - lastMessageAt : null };
    },
  };
}

module.exports = {
  DEFAULT_BASE,
  DEFAULT_WS,
  queryString,
  createPolymarketHttp,
  createPolymarketRfqWs,
  DEFAULT_WS_STALL_MS,
  parsePrivateMessage,
  orderUpdateFromMessage,
  executionsFromOrderUpdate,
};
