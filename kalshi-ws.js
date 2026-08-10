// Authenticated Kalshi WebSocket client for the 'communications' channel.
// Reconnects with backoff + keepalive ping. Emits normalized rfq_created events.
'use strict';
const WebSocket = require('ws');
const { authHeaders } = require('./kalshi-auth');
const { parseEnvelope, isRfqCreated, normalizeRfq } = require('./rfq');

const WS_URL = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const WS_SIGN_PATH = '/trade-api/ws/v2';

function createKalshiWs({ keyId, pem, onRfqCreated, onStatus, onEvent }) {
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
      if (isRfqCreated(env) && onRfqCreated) {
        try { onRfqCreated(normalizeRfq(env), env); } catch (e) { console.error('onRfqCreated', e); }
      }
    });
    ws.on('close', (c) => { clearInterval(pingTimer); status('closed', { code: c }); if (!closedByUs) reconnect(); });
    ws.on('error', (e) => status('error', { message: e && e.message }));
  }
  function reconnect() {
    const wait = Math.min(backoff, 30000);
    status('reconnecting', { wait });
    setTimeout(() => { backoff *= 2; connect(); }, wait);
  }
  return {
    start() { closedByUs = false; connect(); },
    stop() { closedByUs = true; clearInterval(pingTimer); try { ws && ws.close(); } catch (_) {} },
  };
}
module.exports = { createKalshiWs };
