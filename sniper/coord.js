// Combo Locks priority, READ-ONLY. The sniper never quotes an RFQ that combo-worker could quote:
//  - any RFQ that matches an active Combo Lock (same matcher combo-worker uses, rfq.matchParlay),
//  - any RFQ sharing a leg with an active lock (unhedged-boot.lockLegOverlap),
//  - any RFQ with a live combo-worker submission (combo_submissions.is_live for that rfq_id),
//  - and if the lock list is stale/unreadable, NOTHING (fail closed).
// It only SELECTs combo_parlays / combo_submissions; it never writes combo-worker tables or holds.
'use strict';
const { matchParlay } = require('../rfq');
const { lockLegOverlap } = require('../unhedged-boot');

function createLockCoord({ supabase, pollMs = 5000, staleMs = 30000, now = Date.now, log = console.log } = {}) {
  let locks = []; let at = 0; let timer = null;
  const stats = { polls: 0, pollFail: 0, blocked: 0 };
  async function poll() {
    stats.polls += 1;
    try {
      const { data, error } = await supabase.from('combo_parlays').select('*').eq('active', true);
      if (error) throw new Error(error.message);
      locks = data || []; at = now();
    } catch (e) { stats.pollFail += 1; log(`[SNIPER] lock poll failed: ${e.message}`); }
  }
  function start() { poll(); timer = setInterval(poll, pollMs); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); }
  // Synchronous check (memory only) — used at decide, before POST and before confirm.
  function blockReason(rfq) {
    if (!at || now() - at > staleMs) return 'locks_unknown';
    if (matchParlay(rfq, locks)) return 'combo_lock_match';
    if (lockLegOverlap(rfq, locks) > 0) return 'overlaps_combo_lock';
    return null;
  }
  // Async check against combo-worker's live submissions for this RFQ (read-only).
  async function comboWorkerQuoting(rfqId) {
    try {
      const { data, error } = await supabase.from('combo_submissions').select('quote_id').eq('rfq_id', rfqId).eq('is_live', true).limit(1);
      if (error) return 'submissions_unknown';
      return (data && data.length) ? 'combo_worker_quoting' : null;
    } catch (_) { return 'submissions_unknown'; }
  }
  function setLocks(l, t = now()) { locks = l; at = t; } // tests
  return { start, stop, poll, blockReason, comboWorkerQuoting, setLocks, stats: () => ({ ...stats, locks: locks.length, ageMs: at ? now() - at : null }) };
}

module.exports = { createLockCoord };
