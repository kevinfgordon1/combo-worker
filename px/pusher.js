// Minimal Pusher-protocol client (protocol 7) over `ws` for the ProphetX parlay
// socket. Private-channel auth comes from POST /websocket/register, which signs
// every channel for our socket_id. Reconnects with backoff; a watchdog drops the
// socket when ProphetX health_check (or any frame) goes quiet.
'use strict';
const WebSocket = require('ws');

function createPusher({ host, key, register, onEvent, logger = console, quietMs = 45_000, WS = WebSocket } = {}) {
  let ws = null;
  let stopped = false;
  let attempt = 0;
  let lastFrame = 0;
  let watchdog = null;
  let pinger = null;
  const state = { connected: false, channels: [], reconnects: 0 };

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function schedule() {
    if (stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 500);
    attempt += 1;
    state.reconnects += 1;
    setTimeout(connect, delay);
  }

  function cleanup() {
    clearInterval(watchdog); clearInterval(pinger);
    state.connected = false;
  }

  function connect() {
    if (stopped) return;
    const url = `wss://${host}/app/${key}?protocol=7&client=js&version=8.4.0&flash=false`;
    ws = new WS(url);
    lastFrame = Date.now();
    ws.on('message', async (raw) => {
      lastFrame = Date.now();
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      const ev = msg.event;
      if (ev === 'pusher:connection_established') {
        const info = JSON.parse(msg.data || '{}');
        try {
          const channels = await register(info.socket_id);
          state.channels = channels.map((c) => ({ name: c.channel_name, events: c.binding_events || [] }));
          for (const c of channels) send({ event: 'pusher:subscribe', data: { channel: c.channel_name, auth: c.auth } });
          state.connected = true;
          attempt = 0;
          logger.log(`[PX-WS] connected; channels=${state.channels.map((c) => `${c.name.replace(/user=[0-9a-f]+/, 'user=…')}[${c.events.join(',')}]`).join(' ')}`);
        } catch (e) {
          logger.error(`[PX-WS] register failed: ${e.message}`);
          try { ws.close(); } catch (_) {}
        }
        return;
      }
      if (ev === 'pusher:ping') { send({ event: 'pusher:pong', data: {} }); return; }
      if (ev === 'pusher:pong' || ev === 'pusher_internal:subscription_succeeded') return;
      if (ev === 'pusher:error' || ev === 'pusher:subscription_error') {
        logger.error(`[PX-WS] ${ev} ${String(typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)).slice(0, 200)}`);
        return;
      }
      let data = msg.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) {} }
      try { await onEvent(ev, data, msg.channel); } catch (e) { logger.error(`[PX-WS] handler ${ev}: ${e.stack || e.message}`); }
    });
    ws.on('open', () => {
      watchdog = setInterval(() => {
        if (Date.now() - lastFrame > quietMs) {
          logger.warn(`[PX-WS] quiet ${Math.round((Date.now() - lastFrame) / 1000)}s; reconnecting`);
          try { ws.terminate(); } catch (_) {}
        }
      }, 5000);
      pinger = setInterval(() => send({ event: 'pusher:ping', data: {} }), 30_000);
    });
    ws.on('close', (code) => { cleanup(); logger.warn(`[PX-WS] closed code=${code}`); schedule(); });
    ws.on('error', (e) => { logger.warn(`[PX-WS] error ${e.code || e.message}`); });
  }

  return {
    start() { stopped = false; connect(); },
    stop() { stopped = true; cleanup(); try { ws && ws.close(); } catch (_) {} },
    state,
  };
}

module.exports = { createPusher };
