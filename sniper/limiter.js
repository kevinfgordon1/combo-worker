// Per-venue request budget for the isolated sniper. Token bucket + 429 backoff +
// a breaker that trips (and stays tripped until restart) when 429s exceed a threshold.
'use strict';

function createLimiter({ name, ratePerSec, ratePerSecOn429 = null, burst = 1, lowShareRps = 0, reserveLow = false, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let tokens = burst; let last = now(); let backoffUntil = 0; let backoffMs = 0;
  const stats = { name, requests: 0, ok: 0, errors: 0, r429: 0, waitedMs: 0 };
  // reserveLow (Oct 28 2026, SNIPER_CANCEL_RESERVE): lowShareRps is a REAL reservation. A separate
  // bucket refills at lowShareRps and only routine cancels (lane 0) and urgent cancels (lane 2, after
  // the main bucket) may spend it; the main bucket refills at ratePerSec - lowShareRps, so quotes get
  // at most rate - N/s. Idle reserve tokens may be borrowed by a quote only when no lane-0 caller is
  // waiting (costs a newly arriving cancel at most one 1/N s interval). Total never exceeds ratePerSec.
  // reserveLow=false = the old "turn-taking" share (same bucket; quotes usually won the token).
  const reserved = () => reserveLow && lowShareRps > 0;
  const lowRate = () => Math.min(lowShareRps, ratePerSec * 0.5);
  const mainRate = () => (reserved() ? Math.max(0.5, ratePerSec - lowRate()) : ratePerSec);
  const lowBurst = Math.max(1, Math.ceil(lowShareRps / 2));
  let lowTokens = lowBurst;
  function refill() {
    const t = now(); const dt = (t - last) / 1000; last = t;
    tokens = Math.min(burst, tokens + dt * mainRate());
    if (reserved()) lowTokens = Math.min(lowBurst, lowTokens + dt * lowRate());
  }
  stats.reservedLow = 0; stats.borrowedLow = 0;
  // Priority lanes: 2 = urgent (risk-reducing cancels), 1 = normal (quotes/confirms), 0 = low
  // (routine TTL cancels). A caller yields while anyone at a higher level is waiting for a token.
  const waiting = [0, 0, 0]; let lastLow = -Infinity;
  const higherWaiting = (p) => { for (let i = p + 1; i < waiting.length; i += 1) if (waiting[i] > 0) return true; return false; };
  async function acquire(prio = 1, abortIf = null) {
    for (;;) {
      if (abortIf && abortIf()) return false;
      const t = now();
      // Low lane (routine cancels) gets a guaranteed share (lowShareRps, e.g. 1/s) out of the SAME
      // bucket, so it can't starve behind a steady queue of quotes. It still yields to urgent (2).
      if (reserved()) {
        if (t < backoffUntil) { const w = backoffUntil - t; stats.waitedMs += w; await sleep(w); continue; }
        refill();
        if (prio === 0) {
          // Own reserved bucket first (never waits behind quotes), else spare main tokens.
          if (lowTokens >= 1) { lowTokens -= 1; stats.reservedLow += 1; lastLow = t; return true; }
          if (!higherWaiting(0) && tokens >= 1) { tokens -= 1; lastLow = t; return true; }
        } else if (prio === 2) {
          if (tokens >= 1) { tokens -= 1; return true; }
          if (lowTokens >= 1) { lowTokens -= 1; stats.reservedLow += 1; return true; }
        } else {
          if (!higherWaiting(1) && tokens >= 1) { tokens -= 1; return true; }
          if (!higherWaiting(1) && waiting[0] === 0 && lowTokens >= 1) { lowTokens -= 1; stats.borrowedLow += 1; return true; }
        }
        const need = Math.min(prio === 1 ? Infinity : (1 - lowTokens) / lowRate(), (1 - tokens) / mainRate());
        const w = Math.max(5, Math.min(25, Math.ceil(Math.max(0, need) * 1000))); stats.waitedMs += w; await sleep(w);
        continue;
      }
      const lowTurn = prio === 0 && lowShareRps > 0 && t - lastLow >= 1000 / lowShareRps && waiting[2] === 0;
      if (!lowTurn && higherWaiting(prio)) { stats.waitedMs += 25; await sleep(25); continue; }
      if (t < backoffUntil) { const w = backoffUntil - t; stats.waitedMs += w; await sleep(w); continue; }
      refill();
      if (tokens >= 1) { tokens -= 1; if (prio === 0) lastLow = t; return true; }
      const w = Math.ceil(((1 - tokens) / ratePerSec) * 1000); stats.waitedMs += w; await sleep(w);
    }
  }
  function on429() {
    stats.r429 += 1;
    // Optional permanent step-down after any 429 (e.g. sniper 6/s -> 4/s) until restart.
    if (ratePerSecOn429 != null && ratePerSecOn429 > 0 && ratePerSecOn429 < ratePerSec) { ratePerSec = ratePerSecOn429; stats.degraded = true; }
    backoffMs = Math.min(60000, backoffMs ? backoffMs * 2 : 2000);
    backoffUntil = now() + backoffMs;
  }
  function onOk() { stats.ok += 1; backoffMs = 0; }
  // fn() -> fetch Response-like ({ status, ok, json() })
  // abortIf(): checked while waiting for a token; true => give up without spending one and
  // resolve { aborted: true } (used to skip a queued TTL cancel once Kalshi closed the RFQ).
  async function run(fn, { low = false, priority, abortIf = null } = {}) {
    const prio = Math.max(0, Math.min(2, Number.isInteger(priority) ? priority : (low ? 0 : 1)));
    waiting[prio] += 1;
    let got;
    try { got = await acquire(prio, abortIf); } finally { waiting[prio] -= 1; }
    if (!got) { stats.aborted = (stats.aborted || 0) + 1; return { aborted: true }; }
    stats.requests += 1;
    const r = await fn();
    if (r && r.status === 429) { on429(); const e = new Error(`${name} 429`); e.is429 = true; throw e; }
    if (!r || !r.ok) { stats.errors += 1; throw new Error(`${name} HTTP ${r && r.status}`); }
    onOk();
    return r;
  }
  // waitingAt(p): callers currently waiting for a token in lane p (send-queue deadline estimate).
  return { run, stats: () => ({ ...stats, backoffMs, ratePerSec, reserveLow: reserved(), mainRps: mainRate(), lowRps: reserved() ? lowRate() : lowShareRps }), on429, waitingAt: (p) => waiting[p] || 0, rate: () => ratePerSec, lowShareRps: () => (reserved() ? lowRate() : lowShareRps), reserveLow: () => reserved(), _state: () => ({ tokens, lowTokens, backoffUntil }) };
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
