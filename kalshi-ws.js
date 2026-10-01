// Authenticated Kalshi WebSocket client for the 'communications' channel.
// Reconnects with backoff + keepalive ping.
// Emits: rfq_created, rfq_deleted (and other RFQ close types), quote_accepted,
// quote_executed (and optional onEvent for everything).
//
// Recovery (quiet-Kalshi after a post-deploy burst):
//   1. `unexpected-response` — ws does NOT emit close/error on a 401
//      handshake (header_timestamp_expired). Without this hook the socket
//      is dead forever and Poly keeps quoting the same lock.
//   2. Stall watchdog — zombie TCP / dropped subscription still looks
//      OPEN. Liveness is any WS frame: communications messages, subscribe
//      acks, or keepalive ping/pong. A quiet Saturday book (no rfq_created
//      for >20s) must NOT reconnect while pongs succeed. Reconnect only
//      when STALL_MS elapses with no message and no pong.
//   3. Single-flight reconnect — close + handshake-fail must not stack
//      timers or leave two sockets on one API key.
//   4. Backoff — do not reset to 1s on `open`. A stall→open→quiet loop
//      used to hammer Kalshi every ~21s. Reset backoff only after a
//      proven-live frame (message or pong).
//   5. Communications `unsubscribed` / channel-dead `error` — the socket
//      can keep ponging after Kalshi drops the only channel we quote on.
//      Stall watchdog will not fire. Close + resubscribe immediately.
//
// FIREHOSE: peak NFL volume is ~2–2.7k communications frames/s. Parsing
// and matching every rfq_created on this callback fills Kalshi's
// per-subscription buffer (error code 25). createKalshiFirehose opens one
// socket per shard_key (default 8 on the live runner) and drops
// rfq_created frames that miss lock needles before JSON.parse. quote_*
// and rfq close frames are never dropped. A shard reconnect pauses only
// that socket.
//
// SINGLE-SUBSCRIBER: Kalshi keeps ONE full communications subscription per
// API key. A second process on the same KALSHI_KEY_ID (quote-watcher, a
// second replica, unhedged on a copied key) gets `unsubscribed` ~30–40s
// later while TCP/pongs stay up. Sharded sockets inside this process are
// one subscriber split by shard_key, not a second process. If Kalshi
// rejects that split, the firehose collapses to one unsharded socket.
// quote-watcher must stay parked or set QUOTE_WATCHER_WS=0 /
// KALSHI_WS_OWNER=combo.
'use strict';
const WebSocket = require('ws');
const { authHeaders, applyServerDate, isTimestampExpired } = require('./kalshi-auth');
const { parseEnvelope, peekEnvelopeType, isRfqCreated, isRfqClosed, normalizeRfq, normalizeRfqClosed } = require('./rfq');
const { captureRfq } = require('./rfq-debug');

const WS_URL = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const WS_SIGN_PATH = '/trade-api/ws/v2';
// 20s of zero frames (no communications message AND no keepalive pong)
// is a dead socket. Quiet books still pong; do not treat them as dead.
const DEFAULT_STALL_MS = 20_000;
const STALL_TICK_MS = 5_000;
const PING_MS = 10_000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// Dead-channel reconnects (code 25 buffer overflow / code 10 / unsubscribed). The old fixed
// 1000ms wait blacked a shard out for ~1.3s per event (480 events Sep 25-27). First retry is
// now ~100-200ms with jitter; repeated drops of the SAME socket inside the storm window
// escalate (x2 each, capped) so a genuine storm cannot hammer Kalshi.
const FAST_RECONNECT_MS = 100;
const FAST_RECONNECT_JITTER_MS = 100;
const STORM_WINDOW_MS = 60_000;
const STORM_MAX_WAIT_MS = 8_000;
const MAX_SHARD_FACTOR = 100;
// Combo Locks default. Other callers pass 1 (a single unsharded socket).
const DEFAULT_LIVE_SHARD_FACTOR = 8;
// Each shard above this rate is seeing an unsplit firehose, not 1/N.
const UNSLIT_SHARD_PER_SEC = 2000;
const RFQ_DEDUPE_MS = 2000;
const QUOTE_ACCEPT_DEDUPE_MS = 5000;
const QUOTE_EXEC_DEDUPE_MS = 250;

function readShardFactor(explicit, env = process.env, fallback = 1) {
  const fromEnv = env && Object.prototype.hasOwnProperty.call(env, 'KALSHI_WS_SHARD_FACTOR')
    ? env.KALSHI_WS_SHARD_FACTOR
    : undefined;
  const raw = explicit != null ? explicit : fromEnv;
  const chosen = (raw == null || raw === '') ? fallback : raw;
  const n = Number(chosen);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.min(MAX_SHARD_FACTOR, Math.floor(n)));
}

function shardsLookUnsplit(rates, factor) {
  if (!(factor > 1) || !rates || rates.length < factor) return false;
  return rates.every((r) => r > UNSLIT_SHARD_PER_SEC);
}

function headString(data, n) {
  if (typeof data === 'string') return data.length > n ? data.slice(0, n) : data;
  if (Buffer.isBuffer(data)) return data.toString('utf8', 0, Math.min(data.length, n));
  return String(data == null ? '' : data).slice(0, n);
}

// Type sits at the front of Kalshi frames. Unknown → caller must not drop.
function peekTypeFast(data) {
  const head = headString(data, 160);
  const m = /"type"\s*:\s*"([a-z0-9_]+)"/i.exec(head);
  return m ? m[1] : null;
}

function toRawString(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return String(data);
}

function createStats() {
  return {
    recv: 0,
    drop: 0,
    parse: 0,
    quotes: 0,
    backlog: 0,
    maxHandlerNs: 0,
    reconnects: 0,
    windowReconnects: 0,
    reconnectByReason: {},
    windowReconnectByReason: {},
    lastGapMs: null,
    maxGapMs: 0,
    windowMaxGapMs: 0,
    windowRecv: 0,
    windowDrop: 0,
    dropDeleted: 0,
    windowDropDeleted: 0,
    windowParse: 0,
    windowQuotes: 0,
    windowStarted: Date.now(),
  };
}

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

function envelopeMsg(env) {
  const m = env && env.msg;
  if (!m || typeof m !== 'object') return env && env.type;
  return m.message || m.msg || m.error || m.code || (env && env.type);
}

function envelopeCode(env) {
  const m = env && env.msg;
  if (!m || typeof m !== 'object') return undefined;
  return m.code;
}

// Communications `unsubscribed` always means the RFQ channel is gone.
// Error frames: 9 (channel auth), 10 (channel error while running the
// sub), 25 (subscription buffer overflow). Other command errors (bad
// JSON, already subscribed, shard params) are not a dropped sub.
function deadChannelReason(env) {
  if (!env || !env.type) return null;
  if (env.type === 'unsubscribed') return 'unsubscribed';
  if (env.type !== 'error') return null;
  const code = Number(envelopeCode(env));
  if (code === 9 || code === 10 || code === 25) return 'channel_error';
  const text = String(envelopeMsg(env) || '');
  if (/unsubscribed|not subscribed|channel error|buffer overflow|authentication required/i.test(text)) {
    return 'channel_error';
  }
  return null;
}

function envFlagOff(raw) {
  if (raw == null || raw === '') return false;
  const s = String(raw).trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'off' || s === 'no';
}

// quote-watcher must not steal Combo Locks' communications socket.
// Off when QUOTE_WATCHER_WS is 0/false/off, or KALSHI_WS_OWNER is set
// to anyone other than quote-watcher / watcher.
function shouldOpenQuoteWatcherWs(env = process.env) {
  if (!env) return true;
  if (envFlagOff(env.QUOTE_WATCHER_WS)) return false;
  const owner = String(env.KALSHI_WS_OWNER || '').trim().toLowerCase();
  if (!owner) return true;
  return owner === 'quote-watcher' || owner === 'watcher';
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
  shouldDeferCreated,
  shouldDropCreated,
  shouldDropDeleted,
  shardFactor,
  shardKey,
  captureRfq: captureFn,
  WebSocket: WsImpl,
  random,
  fastReconnectMs,
} = {}) {
  const Ws = WsImpl || WebSocket;
  const capture = captureFn || captureRfq;
  const stallAfter = readStallMs(stallMs);
  const shardN = shardFactor != null ? Number(shardFactor) : null;
  const useShard = shardN > 1 && shardKey != null && shardKey !== '';
  let ws = null, subId = 1, pingTimer = null, stallTimer = null;
  let backoff = INITIAL_BACKOFF_MS, closedByUs = false, reconnectTimer = null;
  let lastCommAt = 0;
  let droppedAt = 0;          // when the current outage began (forceReconnect / close)
  let awaitingFirstFrame = false;
  const recentDrops = [];     // timestamps of this socket's recent dead-channel drops
  const rnd = typeof random === 'function' ? random : Math.random;
  const fastMs = fastReconnectMs != null && Number.isFinite(Number(fastReconnectMs))
    ? Number(fastReconnectMs) : FAST_RECONNECT_MS;
  const stats = createStats();
  const status = (s, i) => {
    let payload = i;
    if (useShard) payload = Object.assign({ shardKey: Number(shardKey), shardFactor: shardN }, i || {});
    try { onStatus && onStatus(s, payload); } catch (_) {}
  };

  function noteHandler(started) {
    const dt = Number(process.hrtime.bigint() - started);
    if (dt > stats.maxHandlerNs) stats.maxHandlerNs = dt;
  }

  function touchAlive() {
    lastCommAt = Date.now();
  }

  // Message, subscribe ack, or keepalive pong/ping — socket is not a zombie.
  // Reset reconnect backoff here, not on `open` (open used to restart a
  // 1s stall storm every quiet 20s).
  function touchComm() {
    touchAlive();
    backoff = INITIAL_BACKOFF_MS;
    if (awaitingFirstFrame && droppedAt) {
      // First proven-live frame after a reconnect: how long this shard was blind.
      const gap = Date.now() - droppedAt;
      stats.lastGapMs = gap;
      if (gap > stats.maxGapMs) stats.maxGapMs = gap;
      if (gap > stats.windowMaxGapMs) stats.windowMaxGapMs = gap;
      awaitingFirstFrame = false;
    }
  }

  function noteReconnect(reason) {
    stats.reconnects++;
    stats.windowReconnects++;
    const k = String(reason || 'unknown');
    stats.reconnectByReason[k] = (stats.reconnectByReason[k] || 0) + 1;
    stats.windowReconnectByReason[k] = (stats.windowReconnectByReason[k] || 0) + 1;
  }

  // Wait before re-dialing a socket whose channel died. Jittered, fast first retry,
  // doubling for repeated drops of this socket inside STORM_WINDOW_MS.
  function deadChannelWait(now) {
    while (recentDrops.length && now - recentDrops[0] > STORM_WINDOW_MS) recentDrops.shift();
    const n = recentDrops.length; // prior drops in the window (this one not yet counted)
    recentDrops.push(now);
    const base = Math.min(fastMs * Math.pow(2, n), STORM_MAX_WAIT_MS);
    return Math.round(base + rnd() * Math.min(FAST_RECONNECT_JITTER_MS * Math.pow(2, n), base));
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
    const now = Date.now();
    if (!droppedAt || !awaitingFirstFrame) droppedAt = now;
    awaitingFirstFrame = true;
    let wait;
    if (opts.fast) wait = deadChannelWait(now);
    else wait = immediate ? 250 : Math.min(backoff, MAX_BACKOFF_MS);
    noteReconnect(reason);
    status('reconnecting', { wait, reason });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!immediate && !opts.fast) backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
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
      const expired = isTimestampExpired(statusCode, snippet);
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
    ws = new Ws(WS_URL, {
      headers,
      perMessageDeflate: false,
      skipUTF8Validation: true,
    });

    ws.on('open', () => {
      // Grace period only — do not reset backoff or treat open as proven live.
      // A stall→open→quiet loop used to snap backoff to 1s forever.
      touchAlive();
      try {
        const params = { channels: ['communications'] };
        if (useShard) {
          params.shard_factor = shardN;
          params.shard_key = Number(shardKey);
        }
        ws.send(JSON.stringify({ id: subId++, cmd: 'subscribe', params }));
      } catch (e) {
        status('error', { message: e && e.message });
        forceReconnect('subscribe_send');
        return;
      }
      status('subscribed');
      clearTimers();
      const sendPing = () => { try { ws && ws.ping && ws.ping(); } catch (_) {} };
      sendPing();
      pingTimer = setInterval(sendPing, PING_MS);
      const stallTick = Math.max(10, Math.min(STALL_TICK_MS, Math.floor(stallAfter / 2) || STALL_TICK_MS));
      stallTimer = setInterval(checkStall, stallTick);
    });

    // ws keepalive: pong (and an inbound ping) prove TCP is alive even
    // when the communications book is quiet. Do not touch on outbound ping.
    ws.on('pong', () => { touchComm(); });
    ws.on('ping', () => { touchComm(); });

    ws.on('unexpected-response', (req, res) => {
      // ws: failed handshake does not emit open/error/close. Must destroy + reconnect.
      onHandshakeFail(req, res);
    });

    function handleRaw(raw) {
      stats.parse++;
      stats.windowParse++;
      const env = parseEnvelope(raw);
      if (!env) return;
      if (env.type && String(env.type).indexOf('quote_') === 0) {
        stats.quotes++;
        stats.windowQuotes++;
      }

      try { onEvent && onEvent(env); } catch (_) {}

      const deadReason = deadChannelReason(env);
      if (deadReason) {
        const info = { message: String(envelopeMsg(env)), type: env.type };
        const code = envelopeCode(env);
        if (code != null) info.code = code;
        status(deadReason === 'unsubscribed' ? 'unsubscribed' : 'error', info);
        forceReconnect(deadReason, { fast: true });
        return;
      }

      if (env.type === 'error') {
        const info = { message: String(envelopeMsg(env)), type: env.type };
        const code = envelopeCode(env);
        if (code != null) info.code = code;
        status('error', info);
      }

      // RFQ created → existing path. Runs before RFQ-DEBUG so a matched
      // lock can start POST before any debug stringify.
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

      // Quote executed: orders placed on the book. Not a portfolio fill.
      // Live runner confirms order_id against GET /portfolio/fills before
      // any contract count hits the cap.
      if (env.type === 'quote_executed' && onQuoteExecuted) {
        try {
          const m = env.msg || {};
          const q = (m.quote && typeof m.quote === 'object') ? m.quote : m;
          const contractsRaw = m.contracts_fp ?? m.count_fp ?? m.contracts ?? q.contracts_fp ?? q.count_fp ?? q.contracts;
          onQuoteExecuted({
            quoteId: m.quote_id || m.id || q.quote_id || q.id || null,
            rfqId: m.rfq_id || q.rfq_id || null,
            orderId: m.order_id || m.creator_order_id || m.maker_order_id || q.order_id || null,
            clientOrderId: m.client_order_id || q.client_order_id || null,
            marketTicker: m.market_ticker || q.market_ticker || null,
            executedTs: m.executed_ts || q.executed_ts || null,
            contracts: contractsRaw != null && contractsRaw !== '' ? Number(contractsRaw) : null,
            raw: m,
          }, env);
        } catch (e) { console.error('onQuoteExecuted', e); }
      }

      // Always-on hook: no-op unless RFQ_DEBUG_NEEDLE is set. Off the WS
      // tick so JSON/console cannot delay a quote POST already in flight.
      setImmediate(() => { try { capture(env); } catch (_) {} });
    }

    ws.on('message', (d) => {
      const started = process.hrtime.bigint();
      stats.recv++;
      stats.windowRecv++;
      touchComm();
      let kind = null;
      try { kind = peekTypeFast(d); } catch (_) { kind = null; }
      // Only rfq_created is eligible to drop. quote_accepted / quote_executed
      // (confirm + PR #93 fill confirm) and rfq close frames always parse.
      if (kind === 'rfq_created' && shouldDropCreated) {
        let drop = false;
        try { drop = !!shouldDropCreated(d); } catch (_) { drop = false; }
        if (drop) {
          stats.drop++;
          stats.windowDrop++;
          noteHandler(started);
          return;
        }
      }
      const raw = toRawString(d);
      // rfq_deleted is ~half the firehose (one per closed RFQ). It only matters when the
      // RFQ is one we hold a reserve / quote for (release it). Everything else is dropped
      // before JSON.parse + the pendingQuotes scan. quote_* frames are never dropped.
      if (kind === 'rfq_deleted' && shouldDropDeleted) {
        let dropD = false;
        try { dropD = !!shouldDropDeleted(raw); } catch (_) { dropD = false; }
        if (dropD) {
          stats.dropDeleted++;
          stats.windowDropDeleted++;
          noteHandler(started);
          return;
        }
      }
      // While a quote POST/confirm is in flight, unmatched rfq_created
      // frames are deferred (setImmediate) so the HTTP callback is not
      // stuck behind JSON.parse of the communications book. Lock-needle
      // hits and quote_accepted/executed stay on this tick. Fast-drop
      // already removed the non-lock bulk; this still covers fast-drop off.
      const created = kind === 'rfq_created' || peekEnvelopeType(raw) === 'rfq_created';
      if (created && shouldDeferCreated && shouldDeferCreated(raw)) {
        stats.backlog++;
        setImmediate(() => {
          stats.backlog = Math.max(0, stats.backlog - 1);
          handleRaw(raw);
        });
        noteHandler(started);
        return;
      }
      handleRaw(raw);
      noteHandler(started);
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
        backoff,
        shardKey: useShard ? Number(shardKey) : null,
        shardFactor: useShard ? shardN : 1,
        backlog: stats.backlog,
        recv: stats.recv,
        drop: stats.drop,
        parse: stats.parse,
        quotes: stats.quotes,
        reconnects: stats.reconnects,
        reconnectByReason: { ...stats.reconnectByReason },
        lastGapMs: stats.lastGapMs,
        maxGapMs: stats.maxGapMs,
      };
    },
    // Reconnects since the last call (heartbeat window), then reset.
    takeReconnects() {
      const out = {
        count: stats.windowReconnects,
        byReason: { ...stats.windowReconnectByReason },
        maxGapMs: stats.windowMaxGapMs || null,
      };
      stats.windowReconnects = 0;
      stats.windowReconnectByReason = {};
      stats.windowMaxGapMs = 0;
      return out;
    },
    takeThroughput() {
      const now = Date.now();
      const windowMs = Math.max(0, now - stats.windowStarted);
      const h = this.health();
      const snap = {
        windowMs,
        recv: stats.windowRecv,
        drop: stats.windowDrop,
        dropDeleted: stats.windowDropDeleted,
        parse: stats.windowParse,
        quotes: stats.windowQuotes,
        maxHandlerNs: stats.maxHandlerNs,
        backlog: stats.backlog,
        shardKey: h.shardKey,
        up: h.readyState === 1 && !h.reconnectPending,
      };
      stats.windowRecv = 0;
      stats.windowDrop = 0;
      stats.windowDropDeleted = 0;
      stats.windowParse = 0;
      stats.windowQuotes = 0;
      stats.windowStarted = now;
      stats.maxHandlerNs = 0;
      return snap;
    },
  };
}

function rememberRecent(map, key, now, ttl) {
  const prev = map.get(key);
  if (prev != null && now - prev < ttl) return true;
  map.set(key, now);
  if (map.size > 4000) {
    for (const [k, t] of map) {
      if (now - t >= ttl) map.delete(k);
      if (map.size <= 2000) break;
    }
  }
  return false;
}

// One socket per shard_key. Handlers are shared and deduped so a quote or
// RFQ delivered twice (shard fanout overlap) cannot double-confirm or
// double-POST. rfq_deleted is not deduped: release is idempotent and a
// missed close pins a reserve until the 20s TTL.
function createKalshiFirehose(opts = {}) {
  const factor = readShardFactor(opts.shardFactor, opts.env, 1);
  const seenRfq = new Map();
  const seenAccept = new Map();
  const seenExec = new Map();

  const onRfqCreated = opts.onRfqCreated
    ? (rfq, env) => {
      const id = rfq && rfq.rfqId;
      if (id && rememberRecent(seenRfq, String(id), Date.now(), RFQ_DEDUPE_MS)) return;
      opts.onRfqCreated(rfq, env);
    }
    : undefined;
  const onQuoteAccepted = opts.onQuoteAccepted
    ? (evt) => {
      const key = `${evt && evt.quoteId || ''}|${evt && evt.rfqId || ''}`;
      if (key !== '|' && rememberRecent(seenAccept, key, Date.now(), QUOTE_ACCEPT_DEDUPE_MS)) return;
      opts.onQuoteAccepted(evt);
    }
    : undefined;
  const onQuoteExecuted = opts.onQuoteExecuted
    ? (evt) => {
      // Collapse same-millisecond shard copies. A later execution (partial
      // fill) has a new timestamp outside QUOTE_EXEC_DEDUPE_MS and still
      // runs bookFromQuoteExecution / the portfolio-fills confirm path.
      const key = `${evt && evt.quoteId || ''}|${evt && evt.orderId || ''}|${evt && evt.contracts || ''}`;
      if (key !== '||' && rememberRecent(seenExec, key, Date.now(), QUOTE_EXEC_DEDUPE_MS)) return;
      opts.onQuoteExecuted(evt);
    }
    : undefined;

  let sockets = [];
  let collapsed = false;
  let loopLagMs = 0;
  let lagExpected = 0;
  let lagTimer = null;
  const unsubShards = new Set();

  function socketOpts(shardKey) {
    const sharded = factor > 1 && shardKey != null;
    return {
      keyId: opts.keyId,
      pem: opts.pem,
      WebSocket: opts.WebSocket,
      stallMs: opts.stallMs,
      shouldDropCreated: opts.shouldDropCreated,
      shouldDropDeleted: opts.shouldDropDeleted,
      shouldDeferCreated: opts.shouldDeferCreated,
      onRfqCreated,
      onRfqDeleted: opts.onRfqDeleted,
      onQuoteAccepted,
      onQuoteExecuted,
      onEvent: opts.onEvent,
      captureRfq: opts.captureRfq,
      shardFactor: sharded ? factor : null,
      shardKey: sharded ? shardKey : null,
      onStatus: (s, info) => onShardStatus(s, info),
    };
  }

  function startLagTimer() {
    if (lagTimer) return;
    lagExpected = Date.now() + 1000;
    lagTimer = setInterval(() => {
      const t = Date.now();
      loopLagMs = Math.max(0, t - lagExpected);
      lagExpected = t + 1000;
    }, 1000);
    if (lagTimer.unref) lagTimer.unref();
  }

  function stopLagTimer() {
    if (lagTimer) clearInterval(lagTimer);
    lagTimer = null;
  }

  function onShardStatus(s, info) {
    if (collapsed && info && info.shardKey != null) return;
    try { opts.onStatus && opts.onStatus(s, info); } catch (_) {}
    if (collapsed || factor <= 1) return;
    if (s === 'unsubscribed') {
      unsubShards.add(info && info.shardKey);
      if (unsubShards.size >= 2) collapse('two shard sockets received unsubscribed');
      return;
    }
    if (s === 'error') {
      const code = Number(info && info.code);
      if (code === 6 || (code >= 19 && code <= 22)) {
        collapse(`communications subscribe rejected (code ${code})`);
      }
    }
  }

  function collapse(reason) {
    if (collapsed) return;
    collapsed = true;
    const dying = sockets;
    sockets = [];
    for (const s of dying) {
      let key = null;
      try { key = s.health().shardKey; } catch (_) {}
      try { opts.onStatus && opts.onStatus('shard-retired', { shardKey: key, shardFactor: factor, reason }); } catch (_) {}
      try { s.stop(); } catch (_) {}
    }
    console.error(`[kalshi-ws] ${reason}; collapsing to one unsharded communications socket`);
    try { opts.onStatus && opts.onStatus('fallback', { reason, shardFactor: 1 }); } catch (_) {}
    const solo = createKalshiWs(socketOpts(null));
    sockets = [solo];
    solo.start();
  }

  function health() {
    const rows = sockets.map((s) => s.health());
    const up = rows.filter((r) => r.readyState === 1 && !r.reconnectPending).length;
    let stalest = null;
    let lastCommAt = 0;
    let backlog = 0;
    let recv = 0;
    let drop = 0;
    let parse = 0;
    let quotes = 0;
    for (const r of rows) {
      if (r.lastCommAt) {
        lastCommAt = Math.max(lastCommAt, r.lastCommAt);
        const age = Date.now() - r.lastCommAt;
        if (stalest == null || age > stalest) stalest = age;
      }
      backlog += r.backlog || 0;
      recv += r.recv || 0;
      drop += r.drop || 0;
      parse += r.parse || 0;
      quotes += r.quotes || 0;
    }
    return {
      shardFactor: collapsed ? 1 : factor,
      collapsed,
      shardsUp: up,
      shardsDown: Math.max(0, rows.length - up),
      lastCommAt,
      stalestAgeMs: stalest,
      stallMs: rows[0] ? rows[0].stallMs : readStallMs(opts.stallMs),
      reconnectPending: rows.some((r) => r.reconnectPending),
      readyState: rows.length === 1 ? rows[0].readyState : null,
      backlog,
      loopLagMs,
      recv,
      drop,
      parse,
      quotes,
      shards: rows,
    };
  }

  return {
    start() {
      if (sockets.length) return;
      collapsed = false;
      const n = factor > 1 ? factor : 1;
      sockets = [];
      for (let k = 0; k < n; k++) sockets.push(createKalshiWs(socketOpts(factor > 1 ? k : null)));
      for (const s of sockets) s.start();
      startLagTimer();
    },
    stop() {
      stopLagTimer();
      const dying = sockets;
      sockets = [];
      for (const s of dying) {
        try { s.stop(); } catch (_) {}
      }
    },
    health,
    // Reconnects (and the worst blind gap) across every shard since the last call.
    takeReconnects() {
      let count = 0;
      let maxGapMs = null;
      const byReason = {};
      for (const sock of sockets) {
        const r = sock.takeReconnects ? sock.takeReconnects() : null;
        if (!r) continue;
        count += r.count;
        if (r.maxGapMs != null && (maxGapMs == null || r.maxGapMs > maxGapMs)) maxGapMs = r.maxGapMs;
        for (const [k, v] of Object.entries(r.byReason || {})) byReason[k] = (byReason[k] || 0) + v;
      }
      return { count, byReason, maxGapMs };
    },
    takeThroughput() {
      const parts = sockets.map((s) => s.takeThroughput());
      const windowMs = parts.reduce((m, p) => Math.max(m, p.windowMs || 0), 0);
      const sec = Math.max(0.001, windowMs / 1000);
      let recv = 0;
      let drop = 0;
      let dropDeleted = 0;
      let parse = 0;
      let quotes = 0;
      let maxHandlerNs = 0;
      let backlog = 0;
      const perShard = [];
      for (const p of parts) {
        recv += p.recv;
        drop += p.drop;
        dropDeleted += p.dropDeleted || 0;
        parse += p.parse;
        quotes += p.quotes;
        backlog += p.backlog || 0;
        if (p.maxHandlerNs > maxHandlerNs) maxHandlerNs = p.maxHandlerNs;
        perShard.push({
          shardKey: p.shardKey,
          recv: p.recv,
          drop: p.drop,
          recvPerSec: p.recv / sec,
          up: !!p.up,
        });
      }
      const activeFactor = collapsed ? 1 : factor;
      const snap = {
        windowMs,
        recv,
        drop,
        dropDeleted,
        parse,
        quotes,
        backlog,
        maxHandlerMs: maxHandlerNs / 1e6,
        loopLagMs,
        shardsUp: health().shardsUp,
        shardFactor: activeFactor,
        perShard,
      };
      if (
        !collapsed
        && factor > 1
        && windowMs >= 20_000
        && shardsLookUnsplit(perShard.map((p) => p.recvPerSec), factor)
      ) {
        collapse('each shard is receiving an unsharded firehose');
      }
      return snap;
    },
  };
}

function summarizeThroughput(snap) {
  const sec = Math.max(0.001, (snap && snap.windowMs ? snap.windowMs : 0) / 1000);
  const recv = snap && snap.recv || 0;
  const drop = snap && snap.drop || 0;
  const parse = snap && snap.parse || 0;
  return {
    windowSec: Math.round(sec),
    recv,
    recvPerSec: Math.round(recv / sec),
    drop,
    dropPerSec: Math.round(drop / sec),
    dropDeleted: snap && snap.dropDeleted || 0,
    parse,
    parsePerSec: Math.round(parse / sec),
    quotes: snap && snap.quotes || 0,
    backlog: snap && snap.backlog || 0,
    maxHandlerMs: snap && snap.maxHandlerMs != null ? Math.round(snap.maxHandlerMs * 100) / 100 : 0,
    loopLagMs: snap && snap.loopLagMs || 0,
    shardsUp: snap && snap.shardsUp,
    shardFactor: snap && snap.shardFactor,
    perShard: (snap && snap.perShard || []).map((p) => ({
      shardKey: p.shardKey,
      recv: p.recv,
      recvPerSec: Math.round(p.recvPerSec || 0),
      up: p.up,
    })),
  };
}

module.exports = {
  createKalshiWs,
  createKalshiFirehose,
  DEFAULT_STALL_MS,
  DEFAULT_LIVE_SHARD_FACTOR,
  PING_MS,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  FAST_RECONNECT_MS,
  STORM_WINDOW_MS,
  STORM_MAX_WAIT_MS,
  readStallMs,
  readShardFactor,
  shardsLookUnsplit,
  peekTypeFast,
  summarizeThroughput,
  deadChannelReason,
  shouldOpenQuoteWatcherWs,
};
