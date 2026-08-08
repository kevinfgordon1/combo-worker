// Kalshi RSA-PSS request signing. Tolerant of a private key pasted with or
// without the -----BEGIN/END----- armor lines (same fix as the verify endpoint).
'use strict';
const crypto = require('crypto');

function normalizePem(raw) {
  let v = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const t = v.trim();
  if (t.startsWith('-----BEGIN')) return t.endsWith('-----') ? t + '\n' : t;
  const body = t.replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = (body.match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN RSA PRIVATE KEY-----\n${wrapped}\n-----END RSA PRIVATE KEY-----\n`;
}
function sign(pem, tsMs, method, signPath) {
  const msg = String(tsMs) + method.toUpperCase() + signPath; // signPath incl /trade-api/..., no query
  return crypto.sign('sha256', Buffer.from(msg, 'utf8'), {
    key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}
function authHeaders({ keyId, pem, method, signPath, ts = Date.now() }) {
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': String(ts),
    'KALSHI-ACCESS-SIGNATURE': sign(pem, ts, method, signPath),
  };
}
module.exports = { normalizePem, sign, authHeaders };
