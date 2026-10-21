// Per-venue request budget for the isolated sniper. Token bucket + 429 backoff +
// a breaker that trips (and stays tripped until restart) when 429s exceed a threshold.
'use strict';

function createLimiter({ name, ratePerSec, burst = 1, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let tokens = burst; let last = now(); let backoffUntil = 0; let backoffMs = 0;
  const stats = { name, requests: 0, ok: 0, errors: 0, r429: 0, waitedMs: 0 };
  function refill() { const t = now(); tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec); last = t; }
  async function acquire() {
    for (;;) {
      const t = now();
      if (t < backoffUntil) { const w = backoffUntil - t; stats.waitedMs += w; await sleep(w); continue; }
      refill();
      if (tokens >= 1) { tokens -= 1; return; }
      const w = Math.ceil(((1 - tokens) / ratePerSec) * 1000); stats.waitedMs += w; await sleep(w);
    }
  }
  function on429() {
    stats.r429 += 1;
    backoffMs = Math.min(60000, backoffMs ? backoffMs * 2 : 2000);
    backoffUntil = now() + backoffMs;
  }
  function onOk() { stats.ok += 1; backoffMs = 0; }
  // fn() -> fetch Response-like ({ status, ok, json() })
  async function run(fn) {
    await acquire();
    stats.requests += 1;
    const r = await fn();
    if (r && r.status === 429) { on429(); const e = new Error(`${name} 429`); e.is429 = true; throw e; }
    if (!r || !r.ok) { stats.errors += 1; throw new Error(`${name} HTTP ${r && r.status}`); }
    onOk();
    return r;
  }
  return { run, stats: () => ({ ...stats, backoffMs }), on429, _state: () => ({ tokens, backoffUntil }) };
}

// Trips when total 429s across venues within windowMs reach max. onTrip fires once.
function createRateBreaker({ max = 5, windowMs = 10 * 60 * 1000, now = () => Date.now(), onTrip = () => {} } = {}) {
  const hits = []; let tripped = false;
  return {
    hit(venue) {
      const t = now(); hits.push(t);
      while (hits.length && hits[0] < t - windowMs) hits.shift();
      if (!tripped && hits.length >= max) { tripped = true; try { onTrip(venue, hits.length); } catch (_) {} }
    },
    tripped: () => tripped,
    count: () => hits.length,
  };
}

module.exports = { createLimiter, createRateBreaker };
