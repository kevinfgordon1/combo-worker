// RFQ intake guards for the sniper (backlog fix).
//
// The Kalshi communications firehose is ~2,400 rfq_created/s (+ about as many rfq_deleted) on
// one vCPU; ~97% of combos have no NFL leg at all. Parsing and pricing all of it let quotable NFL
// RFQs reach the quote POST 5-58s after creation, where quote-sender's 3s rfq_age gate drops them.
//   1. shouldDropCreated: drop rfq_created frames with no NFL ticker before JSON.parse.
//   2. shouldDropDeleted: drop rfq_deleted frames for RFQs we have no open quote on.
//   3. tooOld: skip an RFQ that is already past the age budget BEFORE pricing / DB reserve, so a
//      stale RFQ never costs a reservation + release round trip (or a wasted POST slot).
//   4. createLatencyStats: per-minute arrival-age / reserve / pre-POST timings for the summary.
'use strict';
const { rfqAgeMs } = require('../quote-sender');

const NFL_NEEDLES = [Buffer.from('KXNFLGAME'), Buffer.from('KXNFLTD'), Buffer.from('KXNCAAFGAME'), Buffer.from('KXNFLSPREAD'), Buffer.from('KXNFLTOTAL'), Buffer.from('KXNCAAFSPREAD'), Buffer.from('KXNCAAFTOTAL')]; // + main spreads/totals (unscoped legs still skip in classify) // + college football ML

function frameHas(raw, needles) {
  if (Buffer.isBuffer(raw)) return needles.some((n) => raw.indexOf(n) !== -1);
  if (Array.isArray(raw)) return raw.some((b) => frameHas(b, needles)); // fragmented ws frame
  const s = String(raw == null ? '' : raw);
  return needles.some((n) => s.includes(n.toString()));
}

// true => drop before parse. Fail open (keep) on anything unexpected.
function createNflFrameFilter(needles = NFL_NEEDLES) {
  return function shouldDropCreated(raw) {
    try { return !frameHas(raw, needles); } catch (_) { return false; }
  };
}

// forEachRfqId(cb) walks the RFQ ids we hold open quotes for.
function createDeletedFilter(forEachRfqId) {
  return function shouldDropDeleted(raw) {
    try {
      const s = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
      let keep = false;
      forEachRfqId((id) => { if (!keep && id && s.includes(id)) keep = true; });
      return !keep;
    } catch (_) { return false; }
  };
}

// -> null (fresh / unknown age) | age in ms (too old)
function tooOld(rfq, nowMs, maxAgeMs) {
  if (!(maxAgeMs > 0)) return null;
  const age = rfqAgeMs(rfq && rfq.createdTs, nowMs);
  return age != null && age > maxAgeMs ? age : null;
}

function createLatencyStats() {
  let s = { arrive: [], reserve: [], prePost: [], staleIntake: 0, staleReserve: 0 };
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  const summ = (a) => { const x = [...a].sort((m, n) => m - n); return { n: x.length, p50: pct(x, 0.5), p90: pct(x, 0.9), max: x.length ? x[x.length - 1] : null }; };
  const push = (a, v) => { if (Number.isFinite(v)) { if (a.length < 20000) a.push(Math.round(v)); } };
  return {
    arrive: (ms) => push(s.arrive, ms),
    reserve: (ms) => push(s.reserve, ms),
    prePost: (ms) => push(s.prePost, ms),
    staleIntake: () => { s.staleIntake += 1; },
    staleReserve: () => { s.staleReserve += 1; },
    snapshot(reset = true) {
      const out = { arriveAgeMs: summ(s.arrive), reserveMs: summ(s.reserve), prePostAgeMs: summ(s.prePost), staleIntake: s.staleIntake, staleReserve: s.staleReserve };
      if (reset) s = { arrive: [], reserve: [], prePost: [], staleIntake: 0, staleReserve: 0 };
      return out;
    },
  };
}

module.exports = { createNflFrameFilter, createDeletedFilter, tooOld, createLatencyStats, NFL_NEEDLES };
