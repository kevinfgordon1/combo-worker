// Kalshi RSA-PSS request signing. Tolerant of a private key pasted with or
// without the -----BEGIN/END----- armor lines (same fix as the verify endpoint).
//
// Clock: Kalshi rejects KALSHI-ACCESS-TIMESTAMP more than a few seconds off
// (header_timestamp_expired 401). Railway/container clocks can drift; apply
// the Date header from any Kalshi HTTP/WS handshake so reconnects sign with
// server-aligned time instead of dying on the first 401.
'use strict';
const crypto = require('crypto');

let clockOffsetMs = 0;

function normalizePem(raw) {
  let v = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const t = v.trim();
  if (t.startsWith('-----BEGIN')) return t.endsWith('-----') ? t + '\n' : t;
  const body = t.replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = (body.match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN RSA PRIVATE KEY-----\n${wrapped}\n-----END RSA PRIVATE KEY-----\n`;
}

function applyServerDate(dateHeader) {
  if (dateHeader == null || dateHeader === '') return clockOffsetMs;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return clockOffsetMs;
  clockOffsetMs = server - Date.now();
  return clockOffsetMs;
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

module.exports = {
  normalizePem, sign, authHeaders,
  applyServerDate, resetClockOffset, clockOffset, signedNow,
};
