// Authenticated Kalshi WebSocket client for the 'communications' channel.
// Reconnects with backoff + keepalive ping.
// Emits: rfq_created, rfq_deleted (and other RFQ close types), quote_accepted,
// quote_executed (and optional onEvent for everything).
'use strict';
const WebSocket = require('ws');
const { authHeaders } = require('./kalshi-auth');
const { parseEnvelope, isRfqCreated, isRfqClosed, normalizeRfq, normalizeRfqClosed } = require('./rfq');

const WS_URL = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const WS_SIGN_PATH = '/trade-api/ws/v2';

function createKalshiWs({
  keyId,
  pem,
  onRfqCreated,
  onRfqDeleted,
  onQuoteAccepted,
  onQuoteExecuted,
  onStatus,
  onEvent,
}) {
  let ws = null, subId = 1, pingTimer = null, backoff = 1000, closedByUs = false;
  const status = (s, i) => { try { onStatus && onStatus(s, i); } catch (_) {} };

  function connect() {
    const headers = authHeaders({ keyId, pem, method: 'GET', signPath: WS_SIGN_PATH });
    status('connecting', { url: WS_URL });
    ws = new WebSocket(WS_URL, { headers });

    ws.on('open', () => {
      backoff = 1000;
      ws.send(JSON.stringify({ id: subId++, cmd: 'subscribe', params: { channels: ['communications'] } }));
      status('subscribed');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.ping(); } catch (_) {} }, 10000);
    });

    ws.on('message', (d) => {
      const env = parseEnvelope(d.toString());
      if (!env) return;

      try { onEvent && onEvent(env); } catch (_) {}

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

module.exports = { createKalshiWs };
