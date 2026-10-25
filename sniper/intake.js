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
// NBA game legs (SNIPER_NBA=1 only; NBA props never match these needles). Kept separate so the
// ~40% of the firehose that is NBA is only parsed when NBA quoting is on.
const NBA_NEEDLES = [Buffer.from('KXNBAGAME'), Buffer.from('KXNBASPREAD'), Buffer.from('KXNBATOTAL')];

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

// O(1) per frame: pull the id / rfq_id string values out of the raw frame (no JSON.parse) and
// look them up with hasRfqId(id) (Set/Map lookups), instead of scanning every open quote id with
// String.includes. No id found => keep (fail open: the frame is parsed as before).
const ID_RE = /"(?:rfq_id|id)"\s*:\s*"([^"]+)"/g;
function createDeletedIdFilter(hasRfqId) {
  return function shouldDropDeleted(raw) {
    try {
      const s = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
      ID_RE.lastIndex = 0; let m; let found = false;
      while ((m = ID_RE.exec(s)) !== null) { found = true; if (hasRfqId(m[1])) return false; }
      return found;
    } catch (_) { return false; }
  };
}

// -> null (fresh / unknown age) | age in ms (too old)
function tooOld(rfq, nowMs, maxAgeMs) {
  if (!(maxAgeMs > 0)) return null;
  const age = rfqAgeMs(rfq && rfq.createdTs, nowMs);
  return age != null && age > maxAgeMs ? age : null;
}

// Stage timing (per RFQ that reaches a stage): kalshi created -> received (ws tick) ->
// handler start -> decided -> reserved -> posted, plus event-loop lag sampled every 200ms.
// staleBuckets splits stale_at_intake by age so own-lag (2-5s) vs genuinely old (>10s) is visible.
const STAGES = ['createdToRecv', 'recvToHandler', 'handlerToDecided', 'decidedToReserved', 'reservedToPosted', 'recvToPosted'];
function emptyState() {
  const st = {}; for (const k of STAGES) st[k] = [];
  return { arrive: [], reserve: [], prePost: [], staleIntake: 0, staleReserve: 0, stage: st, loopLag: [], staleBuckets: { '2-5s': 0, '5-10s': 0, '10-30s': 0, '>30s': 0 } };
}
function staleBucket(ms) { return ms <= 5000 ? '2-5s' : ms <= 10000 ? '5-10s' : ms <= 30000 ? '10-30s' : '>30s'; }

function createLoopLagSampler(push, everyMs = 200) {
  let expected = Date.now() + everyMs;
  const t = setInterval(() => { const n = Date.now(); push(Math.max(0, n - expected)); expected = n + everyMs; }, everyMs);
  if (t.unref) t.unref();
  return { stop: () => clearInterval(t) };
}

function createLatencyStats() {
  let s = emptyState();
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  const summ = (a) => { const x = [...a].sort((m, n) => m - n); return { n: x.length, p50: pct(x, 0.5), p90: pct(x, 0.9), max: x.length ? x[x.length - 1] : null }; };
  const push = (a, v) => { if (Number.isFinite(v)) { if (a.length < 20000) a.push(Math.round(v)); } };
  return {
    arrive: (ms) => push(s.arrive, ms),
    reserve: (ms) => push(s.reserve, ms),
    prePost: (ms) => push(s.prePost, ms),
    staleIntake: (ageMs) => { s.staleIntake += 1; if (Number.isFinite(ageMs)) s.staleBuckets[staleBucket(ageMs)] += 1; },
    stage: (name, ms) => { if (s.stage[name]) push(s.stage[name], ms); },
    loopLag: (ms) => push(s.loopLag, ms),
    staleReserve: () => { s.staleReserve += 1; },
    snapshot(reset = true) {
      const stages = {}; for (const k of STAGES) stages[k] = summ(s.stage[k]);
      const out = { arriveAgeMs: summ(s.arrive), reserveMs: summ(s.reserve), prePostAgeMs: summ(s.prePost), staleIntake: s.staleIntake, staleReserve: s.staleReserve, staleBuckets: { ...s.staleBuckets }, stages, loopLagMs: summ(s.loopLag) };
      if (reset) s = emptyState();
      return out;
    },
  };
}

module.exports = { createDeletedIdFilter, createLoopLagSampler, staleBucket, STAGES, createNflFrameFilter, createDeletedFilter, tooOld, createLatencyStats, NFL_NEEDLES, NBA_NEEDLES };
