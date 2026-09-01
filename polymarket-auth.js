// Polymarket US Retail API request signing.
// Headers: X-PM-Access-Key, X-PM-Timestamp, X-PM-Signature.
// Signature is ed25519 over `{timestamp}{method}{path}`. Secret is base64;
// the first 32 bytes are the seed. Do not send `account`. Never log key material.
'use strict';
const crypto = require('crypto');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function envFlag(name, env = process.env) {
  const v = String(env[name] == null ? '' : env[name]).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isPolymarketRfqLive(env = process.env) {
  return envFlag('POLYMARKET_RFQ_LIVE', env);
}

function seedFromSecret(secretKey) {
  if (secretKey == null || secretKey === '') return null;
  const raw = Buffer.from(String(secretKey).trim(), 'base64');
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

function sign(secretKey, tsMs, method, path) {
  const key = privateKeyFromSecret(secretKey);
  if (!key) throw new Error('invalid Polymarket secret key');
  const msg = String(tsMs) + String(method || '').toUpperCase() + signPath(path);
  return crypto.sign(null, Buffer.from(msg, 'utf8'), key).toString('base64');
}

function authHeaders({ keyId, secretKey, method, path, ts = Date.now() }) {
  const timestamp = String(ts);
  return {
    'X-PM-Access-Key': keyId,
    'X-PM-Timestamp': timestamp,
    'X-PM-Signature': sign(secretKey, timestamp, method, path),
  };
}

module.exports = {
  envFlag,
  isPolymarketRfqLive,
  seedFromSecret,
  signPath,
  sign,
  authHeaders,
};
