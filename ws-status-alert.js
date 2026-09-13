// Gate Kalshi WS Telegram / console alerts.
// Handshake and auth failures page immediately (5 min cooldown).
// A single quiet-book stall must not page — only a stall/reconnect burst
// (repeated failed reconnects or sustained inability to stay up).
'use strict';

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_BURST_COUNT = 3;
const DEFAULT_BURST_WINDOW_MS = 2 * 60_000;

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
  if (!reason || reason === 'stall') return false;
  return true;
}

function formatWsAlert(s, info) {
  const detail = info && typeof info === 'object' ? JSON.stringify(info) : String(info || s);
  const reason = info && info.reason;
  const suffix = s === 'stalled'
    ? 'Repeated firehose stalls — Combo Locks Kalshi quoting may be unreliable until the socket stays up.'
    : (s === 'unsubscribed' || reason === 'unsubscribed' || reason === 'channel_error' || (info && info.type === 'unsubscribed'))
      ? 'Communications channel dropped — Combo Locks Kalshi quoting is paused until we resubscribe.'
      : 'Firehose reconnecting — Combo Locks quoting is paused until communications resume.';
  return `⚠️ Kalshi WS ${s}\n${detail}\n${suffix}`;
}

function createWsStatusAlerter(opts = {}) {
  const cooldownMs = opts.cooldownMs != null ? Number(opts.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const burstCount = opts.burstCount != null ? Number(opts.burstCount) : DEFAULT_BURST_COUNT;
  const burstWindowMs = opts.burstWindowMs != null ? Number(opts.burstWindowMs) : DEFAULT_BURST_WINDOW_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let lastAlertAt = 0;
  const stallAt = [];
  const failAt = [];

  function prune(arr, t) {
    while (arr.length && t - arr[0] > burstWindowMs) arr.shift();
  }

  function takeAlert(t) {
    if (t - lastAlertAt < cooldownMs) return false;
    lastAlertAt = t;
    return true;
  }

  function shouldAlert(s, info) {
    const t = now();
    if (isHandshakeOrAuth(s, info) || isSubscriptionLost(s, info)) return takeAlert(t);
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
    return false;
  }

  return { shouldAlert };
}

module.exports = {
  createWsStatusAlerter,
  formatWsAlert,
  isHandshakeOrAuth,
  isSubscriptionLost,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_BURST_COUNT,
  DEFAULT_BURST_WINDOW_MS,
};
