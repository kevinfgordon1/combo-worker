// Pure candidate filter used by the intake worker (age + leg scope). Exported for tests.
'use strict';
const { tooOld } = require('./intake');
const { rfqAgeMs } = require('../quote-sender');
const { classifyLegs } = require('./engine');

function createCandidateFilter(cfg, { now = () => Date.now(), clock = () => Date.now(), bump = () => {} } = {}) {
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
    if (tooOld(rfq, clock(), cfg.maxAgeMs) != null) { bump('stale_at_intake'); return null; }
    const sr = scopeReason(rfq); if (sr) { bump(sr); return null; }
    return { ...rfq, recvAt, recvAge, workerAt: now() };
  };
}

module.exports = { createCandidateFilter };
