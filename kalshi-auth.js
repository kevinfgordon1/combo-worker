// Kalshi RSA-PSS request signing. Tolerant of a private key pasted with or
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

function normalizePem(raw) {
  let v = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const t = v.trim();
  if (t.startsWith('-----BEGIN')) return t.endsWith('-----') ? t + '\n' : t;
  const body = t.replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = (body.match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN RSA PRIVATE KEY-----\n${wrapped}\n-----END RSA PRIVATE KEY-----\n`;
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

function sign(pem, tsMs, method, signPath) {
  const msg = String(tsMs) + method.toUpperCase() + signPath; // signPath incl /trade-api/..., no query
  return crypto.sign('sha256', Buffer.from(msg, 'utf8'), {
    key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
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
async function signedRequest(requestFn, {
  keyId, pem, method, signPath, path, headers: extraHeaders, body,
} = {}) {
  const run = async () => {
    const headers = {
      ...(extraHeaders || {}),
      ...authHeaders({ keyId, pem, method, signPath }),
    };
    const res = await requestFn({
      method,
      path: path || signPath,
      headers,
      body,
    });
    applyResponseDate(res && res.headers);
    return res;
  };
  let res = await run();
  if (isTimestampExpired(res && res.statusCode, res && res.text)) {
    res = await run();
  }
  return res;
}

module.exports = {
  normalizePem, sign, authHeaders,
  applyServerDate, applyResponseDate, resetClockOffset, clockOffset, signedNow,
  headerDate, isTimestampExpired, signedRequest, DATE_NOISE_MS,
};
