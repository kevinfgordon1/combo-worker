// Pure candidate filter used by the intake worker (age + leg scope). Exported for tests.
'use strict';
const { tooOld } = require('./intake');
const { rfqAgeMs } = require('../quote-sender');
const { classifyLegs, maxLegDaysCheck } = require('./engine');

// cfg.earlyFilter (SNIPER_INTAKE_EARLY_FILTER, default on): also drop, before main ever sees them,
//   duplicate RFQ ids (60s) and RFQs with a leg on a game main has marked started (`started`, a
//   ticker Set main syncs every 2s; game_started is permanent, so this only repeats main's skip).
function createCandidateFilter(cfg, { now = () => Date.now(), clock = () => Date.now(), bump = () => {}, started = new Set(), dedupeMs = 60000, dedupeMax = 200000 } = {}) {
  const seen = new Map(); // rfqId -> ms
  function dup(id, t) {
    if (!id) return false;
    if (seen.has(id) && t - seen.get(id) < dedupeMs) return true;
    seen.set(id, t);
    if (seen.size > dedupeMax) { for (const [k, v] of seen) { if (t - v < dedupeMs && seen.size <= dedupeMax / 2) break; seen.delete(k); } }
    return false;
  }
  function startedLeg(rfq) {
    if (!started.size) return false;
    for (const k of rfq.legKeys || []) if (started.has(String(k).split(':')[0].toUpperCase())) return true;
    return false;
  }
  function scopeReason(rfq) {
    if (!cfg.scope) return null;
    try {
      const cls = classifyLegs(rfq, cfg.scope);
      if (!cls.ok) return `scope_${cls.reason}`;
      if ((rfq.legKeys || []).length !== cls.legs.length) return 'leg_mismatch';
    } catch (_) { return null; } // fail open: main re-checks everything
    return null;
  }
  // -> candidate rfq (with recvAt / recvAge) or null (counted via bump)
  return function candidate(rfq) {
    if (!rfq || !rfq.isCombo) return null;
    const recvAt = now();
    const recvAge = rfqAgeMs(rfq.createdTs, clock());
    if (cfg.earlyFilter && dup(rfq.rfqId, recvAt)) { bump('dup_rfq_intake'); return null; }
    if (tooOld(rfq, clock(), cfg.maxAgeMs) != null) { bump('stale_at_intake'); return null; }
    if (cfg.earlyFilter && startedLeg(rfq)) { bump('game_started_intake'); return null; }
    // cfg.maxLegDays (SNIPER_MAX_LEG_DAYS): ticker-date check only (no kickoffs in the worker); main re-checks with real kickoffs.
    if (cfg.maxLegDays > 0 && maxLegDaysCheck(rfq.legKeys, null, clock(), cfg.maxLegDays)) { bump('leg_beyond_max_days_intake'); return null; }
    const sr = scopeReason(rfq); if (sr) { bump(sr); return null; }
    return { ...rfq, recvAt, recvAge, workerAt: now() };
  };
}

module.exports = { createCandidateFilter };
