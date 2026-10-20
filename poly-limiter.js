// Shared Polymarket request limiter for poly-worker (COMBO_ROLE=poly).
//
// Polymarket US limits are per source IP, shared across every client in the
// process: GET /v1/rfqs, /v1/rfqs/quotes, /v1/rfqs/trades and
// /v1/rfqs/user-id are 1 req/s; everything else is 25 req/s; quote create /
// delete have their own 100 req/s bucket. We stay under them with one GCRA
// token bucket per class, shared by every Polymarket client in the process:
//   rfq     <= 0.8 req/s (burst 1)
//   general <= 20 req/s  (burst 5)
//   write   never waits (quote/confirm/delete/order writes get priority)
// A read that would have to wait longer than its class max wait is dropped
// locally (synthetic 429, no network call) so a backlog never builds up.
'use strict';

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

function classify(method, path) {
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET') return 'write';
  const p = String(path || '').split('?')[0];
  if (p === '/v1/rfqs' || p.startsWith('/v1/rfqs/')) return 'rfq';
  return 'general';
}

function createPolyLimiter({
  rfqRate = 0.8,
  rfqBurst = 1,
  rfqMaxWaitMs = 5000,
  generalRate = 20,
  generalBurst = 5,
  generalMaxWaitMs = 2000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const buckets = {
    rfq: { interval: 1000 / rfqRate, tolerance: (1000 / rfqRate) * (rfqBurst - 1), maxWait: rfqMaxWaitMs, tat: 0 },
    general: { interval: 1000 / generalRate, tolerance: (1000 / generalRate) * (generalBurst - 1), maxWait: generalMaxWaitMs, tat: 0 },
  };
  const stats = { rfq: { ok: 0, waited: 0, dropped: 0 }, general: { ok: 0, waited: 0, dropped: 0 }, write: { ok: 0 } };

  // Reserve a slot. Returns the ms to wait, or -1 when it would exceed maxWait.
  function reserve(cls, maxWaitOverride) {
    const b = buckets[cls];
    const t = now();
    const tat = Math.max(b.tat, t);
    const allowAt = tat - b.tolerance;
    const wait = Math.max(0, allowAt - t);
    const maxWait = maxWaitOverride != null ? maxWaitOverride : b.maxWait;
    if (wait > maxWait) return -1;
    b.tat = tat + b.interval;
    return wait;
  }

  async function acquire(method, path, { maxWaitMs } = {}) {
    const cls = classify(method, path);
    if (cls === 'write') { stats.write.ok += 1; return { ok: true, cls, waitMs: 0 }; }
    const wait = reserve(cls, maxWaitMs);
    if (wait < 0) { stats[cls].dropped += 1; return { ok: false, cls, waitMs: 0 }; }
    stats[cls].ok += 1;
    if (wait > 0) { stats[cls].waited += 1; await sleep(wait); }
    return { ok: true, cls, waitMs: wait };
  }

  // Interval snapshot for the heartbeat; resets counters.
  function rollStats() {
    const out = JSON.parse(JSON.stringify(stats));
    for (const k of Object.keys(stats)) for (const f of Object.keys(stats[k])) stats[k][f] = 0;
    return out;
  }

  return { acquire, classify, rollStats, peekStats: () => JSON.parse(JSON.stringify(stats)) };
}

function isPolyRole(env = process.env) {
  return String(env.COMBO_ROLE || '').trim().toLowerCase() === 'poly';
}

let shared = null;
// One limiter per process, only for poly-worker (or POLY_LIMITER=1). Returns
// null elsewhere so combo-worker behavior is unchanged.
function sharedPolyLimiter(env = process.env) {
  const on = isPolyRole(env) ? String(env.POLY_LIMITER || '1') !== '0' : String(env.POLY_LIMITER || '') === '1';
  if (!on) return null;
  if (!shared) {
    shared = createPolyLimiter({
      rfqRate: num(env.POLY_RFQ_RPS, 0.8),
      generalRate: num(env.POLY_GENERAL_RPS, 20),
    });
  }
  return shared;
}
function resetSharedPolyLimiter() { shared = null; }

module.exports = { createPolyLimiter, sharedPolyLimiter, resetSharedPolyLimiter, classify, isPolyRole };
