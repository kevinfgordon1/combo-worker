// Locked-down HTTP relay for aibetbuilder Live Trading Desk.
// Own Railway process (start-poly-relay.js). No Polymarket key, no Combo
// Locks modules, no Kalshi. Node http + fetch only.
//
// aibetbuilder (kevinfgordon1/aibetbuilder) signs in api/polymarket-us-auth.js:
//   Ed25519 over `${timestamp}${METHOD}${path}`
//   timestamp = X-PM-Timestamp (decimal milliseconds)
//   METHOD    = uppercase HTTP method
//   path      = pathname only (query stripped)
// The client retries one 401, when the request has a query, with
// includeQuery so path becomes pathname + '?' + query exactly as sent.
// Host is not signed. Body is not signed.
// api/polymarket-us-client.js (used by api/live-trading-desk.js) calls:
//   https://api.polymarket.us      signed Retail (POLYMARKET_API_BASE)
//   https://gateway.polymarket.us  unsigned metadata (POLYMARKET_GATEWAY_BASE)
// This process forwards method, raw path + query, X-PM-* headers, and body
// bytes to that host and streams status, headers, and body back. It does
// not re-sign, rewrite the path, or follow redirects.
'use strict';

const http = require('http');
const crypto = require('crypto');

const ALLOWED_HOSTS = Object.freeze([
  'api.polymarket.us',
  'gateway.polymarket.us',
]);
const ALLOWED_HOST_SET = new Set(ALLOWED_HOSTS);

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

const REQUEST_DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'x-poly-relay-secret',
  'x-poly-relay-host',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

const RESPONSE_DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

const CF_1015 = /(?:"code"\s*:\s*1015|error\s*code\s*:\s*1015|\bError\s+1015\b)/i;
const EGRESS_URL = 'https://api.ipify.org';
const MIN_SECRET = 16;
const MAX_SECRET = 512;
const SNIFF_BYTES = 8192;

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeSecret(value) {
  let s = String(value == null ? '' : value).trim();
  if (s.length >= 2) {
    const first = s.charCodeAt(0);
    const last = s.charCodeAt(s.length - 1);
    if ((first === 34 && last === 34) || (first === 39 && last === 39)) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

function secretConfigured(secret) {
  return typeof secret === 'string'
    && secret.length >= MIN_SECRET
    && secret.length <= MAX_SECRET
    && !/[\r\n]/.test(secret);
}

function secretsMatch(provided, expected) {
  const ha = crypto.createHash('sha256').update(String(provided == null ? '' : provided), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(expected == null ? '' : expected), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function normalizeHost(raw) {
  if (raw == null || Array.isArray(raw)) return '';
  const s = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253) return '';
  if (!/^[a-z0-9.-]+$/.test(s)) return '';
  if (s.startsWith('.') || s.endsWith('.') || s.includes('..')) return '';
  return s;
}

function isSafePath(path) {
  if (!path.startsWith('/')) return false;
  let decoded = path;
  for (let i = 0; i < 3; i += 1) {
    let next;
    try { next = decodeURIComponent(decoded); } catch (_) { return false; }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return false;
  const segments = decoded.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return false;
  }
  return true;
}

function buildUpstreamUrl(host, rawUrl) {
  if (!ALLOWED_HOST_SET.has(host)) return null;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8192) return null;
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
  if (rawUrl.includes('\\') || rawUrl.includes('\0') || /[\s\r\n]/.test(rawUrl)) return null;
  const hash = rawUrl.indexOf('#');
  const noHash = hash === -1 ? rawUrl : rawUrl.slice(0, hash);
  const q = noHash.indexOf('?');
  const pathOnly = q === -1 ? noHash : noHash.slice(0, q);
  if (!isSafePath(pathOnly)) return null;
  let parsed;
  try { parsed = new URL(`https://${host}${noHash}`); } catch (_) { return null; }
  if (parsed.username || parsed.password || parsed.port) return null;
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== host) return null;
  return `https://${host}${noHash}`;
}

function blankCounts() {
  return {
    requests: 0,
    forwarded: 0,
    rejected: 0,
    local429: 0,
    upstream429: 0,
    cloudflare1015: 0,
  };
}

function formatMinuteLine(counts) {
  const c = counts || {};
  return '[poly-relay] minute'
    + ` requests=${c.requests || 0}`
    + ` forwarded=${c.forwarded || 0}`
    + ` rejected=${c.rejected || 0}`
    + ` local_429=${c.local429 || 0}`
    + ` upstream_429=${c.upstream429 || 0}`
    + ` cloudflare_1015=${c.cloudflare1015 || 0}`;
}

function createTokenBucket({ rate, capacity, now }) {
  const clock = now || Date.now;
  let tokens = capacity;
  let updatedAt = clock();
  return {
    tryTake() {
      const t = clock();
      const elapsedSec = Math.max(0, (t - updatedAt) / 1000);
      updatedAt = t;
      tokens = Math.min(capacity, tokens + elapsedSec * rate);
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      const retryAfterSec = rate > 0 ? (1 - tokens) / rate : 60;
      return { ok: false, retryAfterSec };
    },
  };
}

function retryAfterHeader(waitSec) {
  const sec = Math.ceil(Number(waitSec) || 1);
  return String(Math.min(60, Math.max(1, sec)));
}

function sendJson(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) headers[k] = v;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function headerList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === '') return [];
  return String(raw).split(',');
}

function forwardRequestHeaders(req) {
  const drop = new Set(REQUEST_DROP);
  for (const part of headerList(req.headers.connection)) {
    const name = part.trim().toLowerCase();
    if (name) drop.add(name);
  }
  const out = {};
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (!name || typeof value !== 'string') continue;
    if (/[\r\n]/.test(value)) continue;
    const lower = name.toLowerCase();
    if (drop.has(lower)) continue;
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = value;
  }
  return out;
}

function copyResponseHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, key) => {
    if (!key || RESPONSE_DROP.has(key)) return;
    if (typeof value !== 'string' || /[\r\n]/.test(value)) return;
    out[key] = value;
  });
  return out;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    function fail(statusCode, error) {
      if (settled) return;
      settled = true;
      const err = new Error(error);
      err.statusCode = statusCode;
      reject(err);
      req.destroy();
    }
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        fail(413, 'body_too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function looksLikeIp(text) {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) {
    return text.split('.').every((part) => {
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }
  return /^[0-9a-f:]+$/i.test(text) && text.includes(':') && text.length <= 45;
}

async function lookupEgressIp(fetchImpl = globalThis.fetch, timeoutMs = 3000) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(EGRESS_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/plain' },
    });
    if (!res || res.status !== 200) return null;
    const text = String(await res.text()).trim();
    return looksLikeIp(text) ? text : null;
  } catch (_) {
    return null;
  }
}

function bump(minute, total, key) {
  minute[key] += 1;
  total[key] += 1;
}

function createPolyRelay(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const logger = opts.logger || ((line) => { console.log(line); });
  const secret = normalizeSecret(env.POLY_RELAY_SECRET);
  const rps = clampInt(env.POLY_RELAY_RPS, 15, 1, 19);
  const burst = clampInt(env.POLY_RELAY_BURST, rps, 1, 19);
  const maxBody = clampInt(env.POLY_RELAY_MAX_BODY, 1048576, 1024, 8 * 1048576);
  const timeoutMs = clampInt(env.POLY_RELAY_TIMEOUT_MS, 15000, 1000, 60000);
  const minuteMs = clampInt(env.POLY_RELAY_LOG_MS, 60000, 1000, 3600000);
  const egressIp = looksLikeIp(String(opts.egressIp || '').trim()) ? String(opts.egressIp).trim() : null;
  const startedAt = Date.now();
  const minute = blankCounts();
  const total = blankCounts();
  const bucket = createTokenBucket({
    rate: rps,
    capacity: burst,
    now: opts.now || Date.now,
  });

  function flushMinute() {
    const snapshot = Object.assign({}, minute);
    const line = formatMinuteLine(snapshot);
    Object.assign(minute, blankCounts());
    try { logger(line); } catch (_) { /* logging must not break the relay */ }
    return snapshot;
  }

  const timer = setInterval(flushMinute, minuteMs);
  if (typeof timer.unref === 'function') timer.unref();

  async function streamUpstream(res, upstreamRes) {
    const status = Number(upstreamRes && upstreamRes.status) || 502;
    if (status === 429) bump(minute, total, 'upstream429');
    const headers = copyResponseHeaders(upstreamRes && upstreamRes.headers);
    res.writeHead(status, headers);
    const body = upstreamRes && upstreamRes.body;
    if (!body || typeof body.getReader !== 'function') {
      res.end();
      return;
    }
    const reader = body.getReader();
    let sniffed = Buffer.alloc(0);
    let flagged = false;
    function sniff(buf) {
      if (flagged || sniffed.length >= SNIFF_BYTES) return;
      const next = Buffer.concat([sniffed, buf]);
      sniffed = next.length > SNIFF_BYTES ? next.subarray(0, SNIFF_BYTES) : next;
      if (CF_1015.test(sniffed.toString('utf8'))) flagged = true;
    }
    try {
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const buf = Buffer.from(step.value);
        sniff(buf);
        if (!res.write(buf)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (_) {
      if (!res.writableEnded) res.destroy();
      try { await reader.cancel(); } catch (__) { /* already closed */ }
    } finally {
      if (flagged) bump(minute, total, 'cloudflare1015');
    }
  }

  async function handle(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const rawUrl = req.url || '/';
    const pathOnly = rawUrl.split('?')[0];

    if (pathOnly === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      const uptimeSec = Math.max(0, Math.round((Date.now() - startedAt) / 100) / 10);
      if (method === 'HEAD') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      sendJson(res, 200, {
        ok: true,
        service: 'poly-relay',
        uptimeSec,
        egressIp,
      });
      return;
    }

    bump(minute, total, 'requests');

    function reject(status, error, extra) {
      bump(minute, total, 'rejected');
      if (!res.headersSent) sendJson(res, status, { ok: false, error }, extra);
      req.resume();
    }

    if (!ALLOWED_METHODS.has(method)) {
      reject(405, 'method_not_allowed');
      return;
    }
    if (!secretConfigured(secret)) {
      reject(503, 'relay_not_configured');
      return;
    }
    const provided = req.headers['x-poly-relay-secret'];
    if (Array.isArray(provided) || typeof provided !== 'string' || provided.length > MAX_SECRET) {
      secretsMatch('x', secret);
      reject(401, 'unauthorized');
      return;
    }
    if (!secretsMatch(provided, secret)) {
      reject(401, 'unauthorized');
      return;
    }

    const host = normalizeHost(req.headers['x-poly-relay-host']);
    const upstream = buildUpstreamUrl(host, rawUrl);
    if (!upstream) {
      reject(403, 'upstream_not_allowed');
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      reject(413, 'body_too_large');
      return;
    }

    const slot = bucket.tryTake();
    if (!slot.ok) {
      bump(minute, total, 'local429');
      req.resume();
      sendJson(res, 429, { ok: false, error: 'relay_rate_limited' }, {
        'retry-after': retryAfterHeader(slot.retryAfterSec),
      });
      return;
    }

    let body;
    try {
      body = await readBody(req, maxBody);
    } catch (err) {
      const status = err && err.statusCode === 413 ? 413 : 400;
      reject(status, status === 413 ? 'body_too_large' : 'bad_request');
      return;
    }

    const init = {
      method,
      headers: forwardRequestHeaders(req),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body.length && method !== 'GET' && method !== 'HEAD') init.body = body;

    bump(minute, total, 'forwarded');
    let upstreamRes;
    try {
      upstreamRes = await fetchImpl(upstream, init);
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (!res.headersSent) {
        sendJson(res, timedOut ? 504 : 502, {
          ok: false,
          error: timedOut ? 'upstream_timeout' : 'upstream_unreachable',
        });
      }
      return;
    }
    await streamUpstream(res, upstreamRes);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { ok: false, error: 'relay_error' });
    });
  });
  server.requestTimeout = timeoutMs + 5000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;

  function listen(port, host) {
    const listenPort = Number(port) || 0;
    const listenHost = host || '0.0.0.0';
    return new Promise((resolve, reject) => {
      function onError(err) { reject(err); }
      server.once('error', onError);
      server.listen(listenPort, listenHost, () => {
        server.removeListener('error', onError);
        resolve(server.address());
      });
    });
  }

  function close() {
    clearInterval(timer);
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return {
    listen,
    close,
    flushMinute,
    server,
    rps,
    burst,
    maxBody,
    timeoutMs,
    allowedHosts: ALLOWED_HOSTS,
    stats: { minute, total },
  };
}

module.exports = {
  ALLOWED_HOSTS,
  EGRESS_URL,
  createPolyRelay,
  createTokenBucket,
  buildUpstreamUrl,
  secretsMatch,
  secretConfigured,
  normalizeHost,
  formatMinuteLine,
  lookupEgressIp,
  forwardRequestHeaders,
  CF_1015,
};
