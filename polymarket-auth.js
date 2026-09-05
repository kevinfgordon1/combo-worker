// Polymarket US Retail API request signing.
// Headers: X-PM-Access-Key, X-PM-Timestamp, X-PM-Signature.
// Signature is ed25519 over `{timestamp}{method}{path}`. Official docs and
// the US SDK sign pathname only (no query). Secret is base64; the first 32
// bytes are the seed. Do not send `account`. Never log key material.
// This is NOT CLOB L1 (EIP-712) or L2 (HMAC POLY_* headers).
'use strict';
const crypto = require('crypto');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const CLOB_ENV_KEYS = [
  'POLYMARKET_PASSPHRASE',
  'POLY_PASSPHRASE',
  'POLY_API_KEY',
  'POLY_SECRET',
  'POLY_ADDRESS',
  'CLOB_API_KEY',
  'CLOB_SECRET',
  'CLOB_API_SECRET',
  'CLOB_PASSPHRASE',
];

const ROTATE_HINT =
  'rotate Railway POLYMARKET_KEY_ID + POLYMARKET_SECRET_KEY (Retail Ed25519 from polymarket.us/developer — not CLOB L1/L2)';

function envFlag(name, env = process.env) {
  const v = String(env[name] == null ? '' : env[name]).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isPolymarketRfqLive(env = process.env) {
  return envFlag('POLYMARKET_RFQ_LIVE', env);
}

function normalizeCred(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  if ((first === 34 && last === 34) || (first === 39 && last === 39)) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function seedFromSecret(secretKey) {
  const s = normalizeCred(secretKey);
  if (!s) return null;
  const raw = Buffer.from(s, 'base64');
  if (raw.length < 32) return null;
  return raw.subarray(0, 32);
}

function privateKeyFromSecret(secretKey) {
  const seed = seedFromSecret(secretKey);
  if (!seed) return null;
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function signPath(path) {
  if (path == null) return '/';
  const s = String(path);
  const q = s.indexOf('?');
  return q === -1 ? s : s.slice(0, q);
}

function messagePath(path, { includeQuery = false } = {}) {
  const s = path == null ? '/' : String(path);
  return includeQuery ? s : signPath(s);
}

function sign(secretKey, tsMs, method, path, opts = {}) {
  const key = privateKeyFromSecret(secretKey);
  if (!key) throw new Error('invalid Polymarket secret key');
  const msg = String(tsMs) + String(method || '').toUpperCase() + messagePath(path, opts);
  return crypto.sign(null, Buffer.from(msg, 'utf8'), key).toString('base64');
}

function authHeaders({
  keyId,
  secretKey,
  method,
  path,
  ts = Date.now(),
  includeQuery = false,
} = {}) {
  const timestamp = String(ts);
  return {
    'X-PM-Access-Key': normalizeCred(keyId),
    'X-PM-Timestamp': timestamp,
    'X-PM-Signature': sign(secretKey, timestamp, method, path, { includeQuery }),
  };
}

function inspectPolymarketSecret(secretKey) {
  const s = normalizeCred(secretKey);
  if (!s) return { format: 'missing', seedBytes: 0 };
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(s)) return { format: 'pem', seedBytes: 0 };
  if (/^0x[0-9a-fA-F]{32,}$/.test(s)) return { format: 'hex', seedBytes: 0 };
  let raw;
  try {
    raw = Buffer.from(s, 'base64');
  } catch (_) {
    return { format: 'undecodable', seedBytes: 0 };
  }
  if (raw.length < 32) return { format: 'short', seedBytes: raw.length };
  if (raw.length === 32 || raw.length === 64) return { format: 'ed25519', seedBytes: 32 };
  return { format: 'unexpected_len', seedBytes: raw.length };
}

function inspectPolymarketCreds({ keyId, secretKey } = {}, env = process.env) {
  const id = normalizeCred(keyId != null ? keyId : env.POLYMARKET_KEY_ID);
  const secret = secretKey != null ? secretKey : env.POLYMARKET_SECRET_KEY;
  const secretInfo = inspectPolymarketSecret(secret);
  const clobEnvKeys = CLOB_ENV_KEYS.filter((k) => {
    const v = env[k];
    return v != null && String(v).trim() !== '';
  });
  const keyIdLooksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  return {
    keyIdPresent: Boolean(id),
    keyIdChars: id.length,
    keyIdLooksUuid,
    secretFormat: secretInfo.format,
    secretSeedBytes: secretInfo.seedBytes,
    clobEnvKeys,
    needsRotate: !id || secretInfo.format !== 'ed25519',
  };
}

function redactAuthText(text) {
  return String(text == null ? '' : text)
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function classifyPolymarketAuthError({ statusCode, json, text } = {}) {
  const raw = (json && typeof json === 'object')
    ? (json.message || json.error || json.reason || json.code || json.type || '')
    : '';
  const publicMessage = redactAuthText(raw || text || '');
  const lower = publicMessage.toLowerCase();
  let reason = statusCode === 403 ? 'forbidden' : 'unauthorized';
  if (/timestamp|clock|skew|too old|too new|stale/.test(lower)) reason = 'clock_skew';
  else if (/signature|invalid sig|ed25519|signing/.test(lower)) reason = 'bad_signature';
  else if (/unknown key|invalid key|access.key|revoked|disabled/.test(lower)) reason = 'invalid_key';
  else if (/rfq|beta|not enabled|not authorized/.test(lower)) reason = 'rfq_not_enabled';
  const needsRotate = reason === 'invalid_key'
    || reason === 'bad_signature'
    || reason === 'rfq_not_enabled'
    || (reason === 'unauthorized' && statusCode === 401);
  return {
    reason,
    publicMessage,
    needsRotate: Boolean(needsRotate && reason !== 'clock_skew'),
    rotateHint: ROTATE_HINT,
  };
}

function formatAuthFailure({ statusCode, classify, creds, signMode, includeStatus = true } = {}) {
  const c = classify || {};
  const bits = [];
  if (includeStatus) bits.push(String(statusCode == null ? '?' : statusCode));
  bits.push(`reason=${c.reason || 'unauthorized'}`);
  if (c.publicMessage) bits.push(`msg=${c.publicMessage}`);
  if (signMode) bits.push(`sign=${signMode}`);
  if (creds) {
    bits.push(`secretFormat=${creds.secretFormat || '?'}`);
    bits.push(`keyId=${creds.keyIdLooksUuid ? 'uuid' : (creds.keyIdPresent ? 'not_uuid' : 'missing')}`);
  }
  if (c.needsRotate) bits.push(ROTATE_HINT);
  return bits.join(' ');
}

module.exports = {
  envFlag,
  isPolymarketRfqLive,
  normalizeCred,
  seedFromSecret,
  signPath,
  messagePath,
  sign,
  authHeaders,
  inspectPolymarketSecret,
  inspectPolymarketCreds,
  classifyPolymarketAuthError,
  formatAuthFailure,
  redactAuthText,
  CLOB_ENV_KEYS,
  ROTATE_HINT,
};
