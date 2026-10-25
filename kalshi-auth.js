// Kalshi request signing (RSA-PSS or Ed25519). Tolerant of a private key pasted with or
// without the -----BEGIN/END----- armor lines (same fix as the verify endpoint).
//
// Clock: Kalshi rejects KALSHI-ACCESS-TIMESTAMP more than a few seconds off
// (header_timestamp_expired 401). Railway/container clocks can drift; apply
// the Date header from any Kalshi HTTP/WS handshake so reconnects sign with
// server-aligned time instead of dying on the first 401.
//
// HTTP Date is second-granularity (RFC 7231). Treating that truncated second
// as exact server time (PR #61) pushed signed timestamps up to ~1s into the
// past — enough for Kalshi to expire an otherwise-good quote POST. Ignore
// Date-resolution noise; when real skew is present, bias to the end of the
// Date second so we do not systematically sign expired.
'use strict';
const crypto = require('crypto');

let clockOffsetMs = 0;

// Date header resolution + typical RTT. Offsets inside this band are noise.
const DATE_NOISE_MS = 1500;

// Accepts RSA (PKCS#1/PKCS#8) and Ed25519 (PKCS#8) keys. A body pasted without
// armor is tried as RSA first (legacy behaviour), then as PKCS#8 (Ed25519).
function normalizePem(raw) {
  let v = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const t = v.trim();
  if (t.startsWith('-----BEGIN')) return t.endsWith('-----') ? t + '\n' : t;
  const body = t.replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = (body.match(/.{1,64}/g) || []).join('\n');
  const rsa = `-----BEGIN RSA PRIVATE KEY-----\n${wrapped}\n-----END RSA PRIVATE KEY-----\n`;
  if (!body) return rsa;
  try { crypto.createPrivateKey(rsa); return rsa; } catch (_) { /* not PKCS#1 RSA */ }
  const pkcs8 = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
  try { crypto.createPrivateKey(pkcs8); return pkcs8; } catch (_) { return rsa; }
}

function headerDate(headers) {
  if (!headers) return null;
  return headers.date || headers.Date || null;
}

function applyServerDate(dateHeader) {
  if (dateHeader == null || dateHeader === '') return clockOffsetMs;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return clockOffsetMs;
  const now = Date.now();
  // End of the Date second — expired means too old, so prefer "not in the past".
  const offset = (server + 999) - now;
  if (Math.abs(offset) < DATE_NOISE_MS) {
    clockOffsetMs = 0;
    return clockOffsetMs;
  }
  clockOffsetMs = offset;
  return clockOffsetMs;
}

function applyResponseDate(headers) {
  return applyServerDate(headerDate(headers));
}

// ---- Midpoint clock sampling (KALSHI_CLOCK_MIDPOINT=1, default off) -------
// Oct 25: a tester child whose event loop lagged 4-12s read Kalshi's Date
// header seconds after it was produced (WS handshake path had no RTT gate),
// computed offsets of -2.9..-7.9s, and then signed every request in the past
// -> 401 header_timestamp_expired on every reconnect. With this switch on:
//   * offset = (Date + 500ms) - midpoint(sentAt, recvAt)
//   * samples are discarded when the round trip is > 1s or the event loop is
//     lagging > 250ms (the Date then describes an old moment)
//   * a sample that moves the offset by more than 1s only steps it 1s
//   * a rejected sample keeps the last good value
const CLOCK_SAMPLE_MAX_RTT_MS = 1000;
const CLOCK_SAMPLE_MAX_LAG_MS = 250;
const CLOCK_MAX_STEP_MS = 1000;
const LAG_TICK_MS = 50;

function clockMidpointEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String((env && env.KALSHI_CLOCK_MIDPOINT) || '').trim());
}

let lagTimer = null;
let lagLastTick = 0;
let lagRecentMax = 0;
let lagRecentAt = 0;
function ensureLagProbe() {
  if (lagTimer) return;
  lagLastTick = Date.now();
  lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - lagLastTick - LAG_TICK_MS);
    lagLastTick = now;
    if (lag >= lagRecentMax || now - lagRecentAt > 1000) { lagRecentMax = lag; lagRecentAt = now; }
  }, LAG_TICK_MS);
  if (lagTimer.unref) lagTimer.unref();
}
// Current lag estimate: worst tick in the last second, or the time the probe
// has been starved right now (a sample handled mid-freeze).
function currentLoopLagMs(now = Date.now()) {
  ensureLagProbe();
  const starving = Math.max(0, now - lagLastTick - LAG_TICK_MS);
  const recent = now - lagRecentAt <= 1000 ? lagRecentMax : 0;
  return Math.max(starving, recent);
}

const clockStats = { accepted: 0, rejectedRtt: 0, rejectedLag: 0, clamped: 0, invalid: 0 };

// -> { offsetMs, accepted, reason }
function applyServerDateSample(dateHeader, { sentAt, recvAt, loopLagMs } = {}) {
  const server = dateHeader == null || dateHeader === '' ? NaN : Date.parse(dateHeader);
  if (!Number.isFinite(server) || !Number.isFinite(sentAt) || !Number.isFinite(recvAt) || recvAt < sentAt) {
    clockStats.invalid += 1;
    return { offsetMs: clockOffsetMs, accepted: false, reason: 'invalid' };
  }
  const rtt = recvAt - sentAt;
  if (rtt > CLOCK_SAMPLE_MAX_RTT_MS) {
    clockStats.rejectedRtt += 1;
    return { offsetMs: clockOffsetMs, accepted: false, reason: 'rtt' };
  }
  const lag = loopLagMs != null ? loopLagMs : currentLoopLagMs();
  if (lag > CLOCK_SAMPLE_MAX_LAG_MS) {
    clockStats.rejectedLag += 1;
    return { offsetMs: clockOffsetMs, accepted: false, reason: 'lag' };
  }
  const mid = sentAt + rtt / 2;
  let target = Math.round(server + 500 - mid);
  if (Math.abs(target) < DATE_NOISE_MS) target = 0;
  const delta = target - clockOffsetMs;
  if (Math.abs(delta) > CLOCK_MAX_STEP_MS) {
    clockStats.clamped += 1;
    clockOffsetMs += Math.sign(delta) * CLOCK_MAX_STEP_MS;
    return { offsetMs: clockOffsetMs, accepted: true, reason: 'clamped' };
  }
  clockStats.accepted += 1;
  clockOffsetMs = target;
  return { offsetMs: clockOffsetMs, accepted: true, reason: 'ok' };
}

function takeClockStats() {
  const out = { ...clockStats, offsetMs: clockOffsetMs };
  for (const k of Object.keys(clockStats)) clockStats[k] = 0;
  return out;
}

function resetClockOffset() {
  clockOffsetMs = 0;
}

function clockOffset() {
  return clockOffsetMs;
}

function signedNow(ts) {
  if (ts != null) return ts;
  return Date.now() + clockOffsetMs;
}

// Re-parsing the PEM on every RSA-PSS sign shows up on the quote POST
// hot path (WS handshake + every REST call). Cache the KeyObject.
const keyObjectCache = new Map();

function privateKeyObject(pem) {
  const raw = String(pem || '');
  let key = keyObjectCache.get(raw);
  if (!key) {
    key = crypto.createPrivateKey(raw);
    keyObjectCache.set(raw, key);
  }
  return key;
}

// Kalshi signs timestamp + METHOD + path with the key's own algorithm:
// RSA-PSS/SHA-256 for RSA keys, plain Ed25519 for Ed25519 keys (Kalshi's
// default key type in the web app since 2026).
function sign(pem, tsMs, method, signPath) {
  const msg = String(tsMs) + method.toUpperCase() + signPath; // signPath incl /trade-api/..., no query
  const key = privateKeyObject(pem);
  const data = Buffer.from(msg, 'utf8');
  if (key.asymmetricKeyType === 'ed25519') return crypto.sign(null, data, key).toString('base64');
  return crypto.sign('sha256', data, {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}

function authHeaders({ keyId, pem, method, signPath, ts }) {
  const useTs = signedNow(ts);
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': String(useTs),
    'KALSHI-ACCESS-SIGNATURE': sign(pem, useTs, method, signPath),
  };
}

function isTimestampExpired(statusCode, text) {
  if (Number(statusCode) !== 401) return false;
  return /timestamp[_\s-]*expired|header[_\s-]*timestamp/i.test(String(text || ''));
}

// Sign immediately before send. On header_timestamp_expired, Date from the
// failed response is already applied; retry once with a fresh timestamp.
//
// requestFn({ method, path, headers, body }) ->
//   Promise<{ statusCode, headers, text }>
// Oct 18 hotfix: only trust a response Date header when the round trip was
// fast. A response handled after a 2s event-loop freeze (or a queued request)
// made the server Date look seconds "old", produced a bogus -2..-3s offset,
// and then every request was signed seconds in the past -> 401 expired.
const MAX_DATE_RTT_MS = 1000;

async function signedRequest(requestFn, {
  keyId, pem, method, signPath, path, headers: extraHeaders, body,
  shouldRetryExpired, onSent,
} = {}) {
  const run = async () => {
    const headers = {
      ...(extraHeaders || {}),
      ...authHeaders({ keyId, pem, method, signPath }),
    };
    const tSend = Date.now();
    const res = await requestFn({
      method,
      path: path || signPath,
      headers,
      body,
    });
    const tRecv = Date.now();
    const netMs = tRecv - tSend;
    if (clockMidpointEnabled()) applyServerDateSample(headerDate(res && res.headers), { sentAt: tSend, recvAt: tRecv });
    else if (netMs <= MAX_DATE_RTT_MS) applyResponseDate(res && res.headers);
    if (typeof onSent === 'function') {
      try { onSent({ netMs, statusCode: res && res.statusCode }); } catch (_) { /* log only */ }
    }
    return res;
  };
  let res = await run();
  if (isTimestampExpired(res && res.statusCode, res && res.text)) {
    if (typeof shouldRetryExpired === 'function' && !shouldRetryExpired()) {
      console.warn(`[kalshi-auth] ${method} ${signPath} header_timestamp_expired — no retry (stale)`);
      return res;
    }
    console.warn(`[kalshi-auth] ${method} ${signPath} header_timestamp_expired — resync + retry`);
    res = await run();
  }
  return res;
}

module.exports = {
  normalizePem, sign, authHeaders, privateKeyObject,
  applyServerDate, applyResponseDate, resetClockOffset, clockOffset, signedNow,
  headerDate, isTimestampExpired, signedRequest, DATE_NOISE_MS, MAX_DATE_RTT_MS,
  applyServerDateSample, clockMidpointEnabled, currentLoopLagMs, takeClockStats,
  CLOCK_SAMPLE_MAX_RTT_MS, CLOCK_SAMPLE_MAX_LAG_MS, CLOCK_MAX_STEP_MS,
};
