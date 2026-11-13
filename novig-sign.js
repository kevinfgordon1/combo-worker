// NOVIG-V3 request signing, shared by the odds relay and the RFQ maker.
// Canonical string, query encoding, and Ed25519 / P-256 signatures match
// Novig's published vectors (novig-signing-vectors.json). Never log a key,
// a signature, or the canonical string of a live request.
'use strict';

const crypto = require('crypto');

const EMPTY_BODY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function normalizePem(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  if (!text.includes('-----BEGIN')) {
    const body = text.replace(/\s+/g, '').match(/.{1,64}/g) || [];
    text = `-----BEGIN PRIVATE KEY-----\n${body.join('\n')}\n-----END PRIVATE KEY-----`;
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

function novigKey(env = process.env) {
  const src = env || {};
  const id = String(src.NOVIG_KEY_ID || '').trim();
  const pem = normalizePem(src.NOVIG_PRIVATE_KEY || '');
  if (!id || !pem) return null;
  try {
    const key = crypto.createPrivateKey(pem);
    return { id, key, type: key.asymmetricKeyType };
  } catch (_) {
    return { id, key: null, type: null, error: 'bad_private_key' };
  }
}

function encodePart(s) {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function decodePart(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

function canonicalQuery(raw) {
  const q = String(raw || '').replace(/^\?/, '');
  if (!q) return '';
  const pairs = q.split('&').map((pair) => {
    const i = pair.indexOf('=');
    const name = i < 0 ? pair : pair.slice(0, i);
    const value = i < 0 ? '' : pair.slice(i + 1);
    return [encodePart(decodePart(name)), encodePart(decodePart(value))];
  });
  pairs.sort((a, b) => {
    const n = Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]));
    return n || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1]));
  });
  return pairs.map(([n, v]) => `${n}=${v}`).join('&');
}

function stringToSign({ timestamp, method, path, query, body }) {
  const hash = body && body.length
    ? crypto.createHash('sha256').update(body).digest('hex')
    : EMPTY_BODY_HASH;
  return ['NOVIG-V3', String(timestamp), String(method).toUpperCase(), path, canonicalQuery(query), hash].join('\n');
}

function signString(keyObject, text) {
  const data = Buffer.from(text, 'utf8');
  if (keyObject.asymmetricKeyType === 'ed25519') {
    return crypto.sign(null, data, keyObject).toString('base64');
  }
  return crypto.sign('sha256', data, { key: keyObject, dsaEncoding: 'der' }).toString('base64');
}

function signedHeaders(key, { method = 'GET', path, query = '', body = '', nowMs = Date.now() } = {}) {
  if (!key || !key.key) throw new Error('novig key is not usable');
  const timestamp = String(Math.floor(nowMs));
  const text = stringToSign({ timestamp, method, path, query, body });
  return {
    'Novig-Key-Id': key.id,
    'Novig-Timestamp': timestamp,
    'Novig-Signature': signString(key.key, text),
  };
}

function novigHttpBase(env = process.env) {
  return String((env || {}).NOVIG_API_BASE || 'https://api.novig.com').replace(/\/+$/, '');
}

function novigRfqWsUrl(base) {
  const u = new URL(base || 'https://api.novig.com');
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = '/rfq/v3/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

module.exports = {
  EMPTY_BODY_HASH,
  normalizePem,
  novigKey,
  encodePart,
  decodePart,
  canonicalQuery,
  stringToSign,
  signString,
  signedHeaders,
  novigHttpBase,
  novigRfqWsUrl,
};
