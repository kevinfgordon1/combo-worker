// Authenticated Kalshi WebSocket client for the 'communications' channel.
// Reconnects with backoff + keepalive ping.
// Emits: rfq_created, rfq_deleted (and other RFQ close types), quote_accepted,
// quote_executed (and optional onEvent for everything).
//
// Recovery (quiet-Kalshi after a post-deploy burst):
//   1. `unexpected-response` — ws does NOT emit close/error on a 401
//      handshake (header_timestamp_expired). Without this hook the socket
//      is dead forever and Poly keeps quoting the same lock.
//   2. Stall watchdog — communications volume is huge; if no channel
//      message arrives for STALL_MS, tear down and reconnect (zombie TCP
//      / dropped subscription still looks "open").
//   3. Single-flight reconnect — close + handshake-fail must not stack
//      timers or leave two sockets on one API key.
'use strict';
const WebSocket = require('ws');
const { authHeaders, applyServerDate } = require('./kalshi-auth');
const { parseEnvelope, isRfqCreated, isRfqClosed, normalizeRfq, normalizeRfqClosed } = require('./rfq');
const { captureRfq } = require('./rfq-debug');

const WS_URL = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const WS_SIGN_PATH = '/trade-api/ws/v2';
// Kalshi combo RFQs run hundreds/sec when the book is live. 20s of zero
// communications is a dead subscription, not a quiet book.
const DEFAULT_STALL_MS = 20_000;
const STALL_TICK_MS = 5_000;

function readStallMs(explicit, env = process.env) {
  if (explicit != null && Number.isFinite(Number(explicit))) return Number(explicit);
  const raw = env && env.KALSHI_WS_STALL_MS;
  if (raw == null || raw === '') return DEFAULT_STALL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_MS;
}

function headerDate(res) {
  if (!res || !res.headers) return null;
  return res.headers.date || res.headers.Date || null;
}

function createKalshiWs({
  keyId,
  pem,
  onRfqCreated,
  onRfqDeleted,
  onQuoteAccepted,
  onQuoteExecuted,
  onStatus,
  onEvent,
  stallMs,
  WebSocket: WsImpl,
} = {}) {
  const Ws = WsImpl || WebSocket;
  const stallAfter = readStallMs(stallMs);
  let ws = null, subId = 1, pingTimer = null, stallTimer = null;
  let backoff = 1000, closedByUs = false, reconnectTimer = null;
  let lastCommAt = 0;
  const status = (s, i) => { try { onStatus && onStatus(s, i); } catch (_) {} };

  function touchComm() {
    lastCommAt = Date.now();
  }

  function clearTimers() {
    clearInterval(pingTimer);
    pingTimer = null;
    clearInterval(stallTimer);
    stallTimer = null;
  }

  function dropSocket(socket) {
    if (!socket) return;
    try { socket.removeAllListeners(); } catch (_) {}
    try { socket.terminate(); } catch (_) {}
  }

  function scheduleReconnect(reason, opts = {}) {
    if (closedByUs) return;
    if (reconnectTimer) {
      status('reconnect-pending', { reason });
      return;
    }
    const immediate = !!(opts.immediate);
    const wait = immediate ? 250 : Math.min(backoff, 30000);
    status('reconnecting', { wait, reason });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!immediate) backoff = Math.min(backoff * 2, 30000);
      connect();
    }, wait);
  }

  function forceReconnect(reason, opts) {
    clearTimers();
    const old = ws;
    ws = null;
    dropSocket(old);
    scheduleReconnect(reason, opts);
  }

  function checkStall() {
    if (closedByUs || !ws) return;
    if (ws.readyState !== Ws.OPEN) return;
    if (!lastCommAt) return;
    const age = Date.now() - lastCommAt;
    if (age < stallAfter) return;
    status('stalled', { age, stallMs: stallAfter });
    forceReconnect('stall');
  }

  function onHandshakeFail(req, res) {
    const chunks = [];
    const finish = (text) => {
      const date = headerDate(res);
      if (date) {
        const offset = applyServerDate(date);
        if (Math.abs(offset) > 2000) {
          status('clock-offset', { offsetMs: offset });
        }
      }
      const snippet = String(text || '').slice(0, 400);
      const statusCode = res && res.statusCode;
      status('error', {
        message: `handshake ${statusCode}: ${snippet}`,
        statusCode,
      });
      try { req && req.destroy && req.destroy(); } catch (_) {}
      const expired = /timestamp_expired|header_timestamp/i.test(snippet);
      forceReconnect(expired ? 'auth_timestamp' : `http_${statusCode || 'handshake'}`, {
        immediate: expired,
      });
    };
    if (!res || typeof res.on !== 'function') {
      finish('');
      return;
    }
    res.on('data', (c) => chunks.push(c));
    res.on('error', () => finish(''));
    res.on('end', () => {
      try {
        finish(Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf8'));
      } catch (_) {
        finish('');
      }
    });
  }

  function connect() {
    if (closedByUs) return;
    const old = ws;
    ws = null;
    dropSocket(old);

    const headers = authHeaders({ keyId, pem, method: 'GET', signPath: WS_SIGN_PATH });
    status('connecting', { url: WS_URL });
    ws = new Ws(WS_URL, { headers });

    ws.on('open', () => {
      backoff = 1000;
      touchComm();
      try {
        ws.send(JSON.stringify({ id: subId++, cmd: 'subscribe', params: { channels: ['communications'] } }));
      } catch (e) {
        status('error', { message: e && e.message });
        forceReconnect('subscribe_send');
        return;
      }
      status('subscribed');
      clearTimers();
      pingTimer = setInterval(() => { try { ws && ws.ping && ws.ping(); } catch (_) {} }, 10000);
      const stallTick = Math.max(10, Math.min(STALL_TICK_MS, Math.floor(stallAfter / 2) || STALL_TICK_MS));
      stallTimer = setInterval(checkStall, stallTick);
    });

    ws.on('unexpected-response', (req, res) => {
      // ws: failed handshake does not emit open/error/close. Must destroy + reconnect.
      onHandshakeFail(req, res);
    });

    ws.on('message', (d) => {
      const env = parseEnvelope(d.toString());
      if (!env) return;
      touchComm();

      try { onEvent && onEvent(env); } catch (_) {}
      // Always-on hook: no-op unless RFQ_DEBUG_NEEDLE is set. Console only
      // (no rfq_debug insert) so Railway 522s cannot hide samples.
      try { captureRfq(env); } catch (_) {}

      if (env.type === 'error' || env.type === 'unsubscribed') {
        const msg = (env.msg && (env.msg.message || env.msg.error || env.msg.code)) || env.type;
        status('error', { message: String(msg), type: env.type });
      }

      // RFQ created → existing path
      if (isRfqCreated(env) && onRfqCreated) {
        try { onRfqCreated(normalizeRfq(env), env); } catch (e) { console.error('onRfqCreated', e); }
      }

      // RFQ closed (deleted / expired / replaced) — release any reserve for that rfq_id
      if (isRfqClosed(env) && onRfqDeleted) {
        try { onRfqDeleted(normalizeRfqClosed(env), env); } catch (e) { console.error('onRfqDeleted', e); }
      }

      // Quote accepted (taker chose our quote) — ids may sit on msg or nested msg.quote
      if (env.type === 'quote_accepted' && onQuoteAccepted) {
        try {
          const m = env.msg || {};
          const q = (m.quote && typeof m.quote === 'object') ? m.quote : m;
          onQuoteAccepted({
            quoteId: m.quote_id || m.id || q.quote_id || q.id || null,
            rfqId: m.rfq_id || q.rfq_id || null,
            acceptedSide: m.accepted_side || q.accepted_side || null,
            contractsAccepted: m.contracts_accepted_fp != null
              ? parseFloat(m.contracts_accepted_fp)
              : (q.contracts_accepted_fp != null ? parseFloat(q.contracts_accepted_fp) : null),
            marketTicker: m.market_ticker || q.market_ticker || null,
            raw: m,
          }, env);
        } catch (e) { console.error('onQuoteAccepted', e); }
      }

      // Quote executed (orders placed — real position)
      if (env.type === 'quote_executed' && onQuoteExecuted) {
        try {
          const m = env.msg || {};
          const q = (m.quote && typeof m.quote === 'object') ? m.quote : m;
          onQuoteExecuted({
            quoteId: m.quote_id || m.id || q.quote_id || q.id || null,
            rfqId: m.rfq_id || q.rfq_id || null,
            orderId: m.order_id || m.creator_order_id || m.maker_order_id || q.order_id || null,
            clientOrderId: m.client_order_id || q.client_order_id || null,
            marketTicker: m.market_ticker || q.market_ticker || null,
            executedTs: m.executed_ts || q.executed_ts || null,
            raw: m,
          }, env);
        } catch (e) { console.error('onQuoteExecuted', e); }
      }
    });

    ws.on('close', (c) => {
      clearTimers();
      status('closed', { code: c });
      if (!closedByUs) scheduleReconnect(c != null ? `close_${c}` : 'close');
    });
    ws.on('error', (e) => status('error', { message: e && e.message }));
  }

  return {
    start() { closedByUs = false; connect(); },
    stop() {
      closedByUs = true;
      clearTimers();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const old = ws;
      ws = null;
      dropSocket(old);
    },
    health() {
      return {
        lastCommAt,
        stallMs: stallAfter,
        readyState: ws ? ws.readyState : null,
        reconnectPending: !!reconnectTimer,
      };
    },
  };
}

module.exports = { createKalshiWs, DEFAULT_STALL_MS, readStallMs };
