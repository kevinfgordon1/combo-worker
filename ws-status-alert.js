// Gate Kalshi WS Telegram / console alerts.
// Handshake and auth failures page immediately (5 min cooldown).
// A single quiet-book stall must not page — only a stall/reconnect burst
// (repeated failed reconnects or sustained inability to stay up).
// Code 25 / channel drops reconnect in about a second. Page only when a
// socket is still down after ~10s, not on every buffer overflow.
'use strict';

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_BURST_COUNT = 3;
const DEFAULT_BURST_WINDOW_MS = 2 * 60_000;
const DEFAULT_DOWN_MS = 10_000;

function infoText(info) {
  if (!info) return '';
  return String(info.message || info.reason || '');
}

function isHandshakeOrAuth(s, info) {
  if (s === 'error') {
    return /handshake|timestamp_expired|header_timestamp/i.test(infoText(info));
  }
  if (s === 'reconnecting') {
    return /auth_timestamp/i.test(String(info && info.reason || ''));
  }
  return false;
}

// Communications dropped while TCP/pongs stayed up. Page immediately —
// a quiet `error` with type=unsubscribed used to be filtered, and the
// stall watchdog never fired.
function isSubscriptionLost(s, info) {
  if (s === 'unsubscribed') return true;
  if (s === 'reconnecting') {
    const reason = String(info && info.reason || '');
    return reason === 'unsubscribed' || reason === 'channel_error';
  }
  if (s === 'error') {
    const type = String(info && info.type || '');
    if (type === 'unsubscribed') return true;
    const code = Number(info && info.code);
    if (code === 9 || code === 10 || code === 25) return true;
    return /unsubscribed|channel error|buffer overflow/i.test(infoText(info));
  }
  return false;
}

function isFailedReconnect(s, info) {
  if (s !== 'reconnecting') return false;
  const reason = String(info && info.reason || '');
  // channel_error (code 25 buffer overflow) and unsubscribed use the
  // sustained-down timer. A 1s reconnect storm must not page.
  if (!reason || reason === 'stall' || reason === 'channel_error' || reason === 'unsubscribed') {
    return false;
  }
  return true;
}

function shardOf(info) {
  if (info && info.shardKey != null && info.shardKey !== '') return String(info.shardKey);
  return '_';
}

function isUpStatus(s) {
  return s === 'subscribed';
}

function isDownStatus(s, info) {
  if (s === 'reconnecting' || s === 'closed' || s === 'unsubscribed' || s === 'stalled') return true;
  if (s === 'error' && isSubscriptionLost(s, info)) return true;
  return false;
}

function formatWsAlert(s, info) {
  const detail = info && typeof info === 'object' ? JSON.stringify(info) : String(info || s);
  const reason = info && info.reason;
  const factor = info && Number(info.shardFactor);
  const up = info && info.shardsUp;
  let suffix;
  if (s === 'stalled') {
    suffix = 'Repeated firehose stalls — Combo Locks Kalshi quoting may be unreliable until the socket stays up.';
  } else if (factor > 1 && up > 0) {
    const shard = info.shardKey != null && info.shardKey !== '_' ? `Shard ${info.shardKey}` : 'One shard';
    const downFor = info.downForMs != null ? ` for ${Math.round(Number(info.downForMs) / 1000)}s` : '';
    suffix = `${shard} still down${downFor} — quoting continues on ${up}/${factor} sockets. This shard's RFQs and quote events are paused until it reconnects.`;
  } else if (s === 'unsubscribed' || reason === 'unsubscribed' || (info && info.type === 'unsubscribed')) {
    suffix = 'Communications channel dropped — Combo Locks Kalshi quoting is paused until we resubscribe.';
  } else {
    suffix = 'Firehose reconnecting — Combo Locks quoting is paused until communications resume.';
  }
  return `⚠️ Kalshi WS ${s}\n${detail}\n${suffix}`;
}

function createWsStatusAlerter(opts = {}) {
  const cooldownMs = opts.cooldownMs != null ? Number(opts.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const burstCount = opts.burstCount != null ? Number(opts.burstCount) : DEFAULT_BURST_COUNT;
  const burstWindowMs = opts.burstWindowMs != null ? Number(opts.burstWindowMs) : DEFAULT_BURST_WINDOW_MS;
  const downMs = opts.downMs != null ? Number(opts.downMs) : DEFAULT_DOWN_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let lastAlertAt = 0;
  const stallAt = [];
  const failAt = [];
  // shard key → first time that socket went down (not reset by repeat events)
  const downSince = new Map();

  function prune(arr, t) {
    while (arr.length && t - arr[0] > burstWindowMs) arr.shift();
  }

  function takeAlert(t) {
    if (t - lastAlertAt < cooldownMs) return false;
    lastAlertAt = t;
    return true;
  }

  function clearDown(shard) {
    downSince.delete(shard);
  }

  function markDown(shard, t) {
    if (!downSince.has(shard)) downSince.set(shard, t);
  }

  function worstDown(t) {
    let worst = null;
    for (const [shard, since] of downSince) {
      const age = t - since;
      if (age < downMs) continue;
      if (!worst || age > worst.age) worst = { shard, age };
    }
    return worst;
  }

  function shouldAlert(s, info) {
    const t = now();
    const shard = shardOf(info);
    if (s === 'shard-retired') {
      clearDown(shard);
      return false;
    }
    if (s === 'fallback') return false;
    if (isUpStatus(s)) {
      clearDown(shard);
      return false;
    }
    if (isDownStatus(s, info)) markDown(shard, t);
    if (isHandshakeOrAuth(s, info)) return takeAlert(t);
    if (s === 'stalled') {
      stallAt.push(t);
      prune(stallAt, t);
      if (stallAt.length < burstCount) return false;
      return takeAlert(t);
    }
    if (isFailedReconnect(s, info)) {
      failAt.push(t);
      prune(failAt, t);
      if (failAt.length < burstCount) return false;
      return takeAlert(t);
    }
    if (worstDown(t)) return takeAlert(t);
    return false;
  }

  // Fires when a socket stays down with no further status events.
  function poll(extra) {
    const t = now();
    const worst = worstDown(t);
    if (!worst) return null;
    if (!takeAlert(t)) return null;
    return {
      s: 'down',
      info: Object.assign({}, extra || {}, {
        shardKey: worst.shard === '_' ? undefined : worst.shard,
        downForMs: worst.age,
        reason: 'sustained_down',
      }),
    };
  }

  return { shouldAlert, poll };
}

module.exports = {
  createWsStatusAlerter,
  formatWsAlert,
  isHandshakeOrAuth,
  isSubscriptionLost,
  isFailedReconnect,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_BURST_COUNT,
  DEFAULT_BURST_WINDOW_MS,
  DEFAULT_DOWN_MS,
};
