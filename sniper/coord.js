// Combo Locks priority, READ-ONLY. The sniper never quotes an RFQ that combo-worker could quote:
//  - any RFQ that matches an active Combo Lock (same matcher combo-worker uses, rfq.matchParlay),
//  - (opt-in only, SNIPER_SKIP_LOCK_OVERLAP=1) any RFQ sharing a leg with an active lock.
//    Default OFF (Oct 25): sharing a leg or two with a lock is fine; only the same parlay is blocked.
//  - any RFQ with a live combo-worker submission (combo_submissions.is_live for that rfq_id),
//  - if the lock list is stale/unreadable, keep quoting against the LAST loaded list (fail open,
//    Oct 25) with a warning + locksStale counter. SNIPER_LOCKS_FAIL_CLOSED=1 restores fail-closed
//    (locks_unknown / submissions_unknown block).
// It only SELECTs combo_parlays / combo_submissions; it never writes combo-worker tables or holds.
'use strict';
const { matchParlay } = require('../rfq');
const { lockLegOverlap } = require('../unhedged-boot');

function createLockCoord({ supabase, pollMs = 5000, staleMs = 30000, now = Date.now, log = console.log,
  skipOverlap = /^(1|true|yes|on)$/i.test(String(process.env.SNIPER_SKIP_LOCK_OVERLAP || '')),
  failClosed = /^(1|true|yes|on)$/i.test(String(process.env.SNIPER_LOCKS_FAIL_CLOSED || '')), warnEveryMs = 60000, cwTimeoutMs = Number(process.env.SNIPER_CW_CHECK_TIMEOUT_MS) || 300,
  // 'query' (default): one combo_submissions query per send (on the hot path, shared client).
  // 'poll': one query every cwPollMs into an in-memory Set; send-time check is a Set lookup.
  cwMode = String(process.env.SNIPER_CW_CHECK_MODE || 'query'), cwPollMs = Number(process.env.SNIPER_CW_POLL_MS) || 500 } = {}) {
  let cwLive = new Set(); let cwAt = 0; let cwTimer = null;
  async function pollSubs() {
    try {
      const { data, error } = await supabase.from('combo_submissions').select('rfq_id').eq('is_live', true).limit(5000);
      if (error) throw new Error(error.message);
      cwLive = new Set((data || []).map((r) => r.rfq_id)); cwAt = now();
    } catch (_) { stats.cwPollFail = (stats.cwPollFail || 0) + 1; }
  }
  let locks = []; let at = 0; let timer = null;
  const stats = { polls: 0, pollFail: 0, blocked: 0, staleChecks: 0, submissionsUnknown: 0 }; let lastWarn = 0;
  const isStale = () => !at || now() - at > staleMs;
  async function poll() {
    stats.polls += 1;
    try {
      const { data, error } = await supabase.from('combo_parlays').select('*').eq('active', true);
      if (error) throw new Error(error.message);
      locks = data || []; at = now();
    } catch (e) { stats.pollFail += 1; log(`[SNIPER] lock poll failed: ${e.message}`); }
  }
  function start() {
    poll(); timer = setInterval(poll, pollMs); if (timer.unref) timer.unref();
    if (cwMode === 'poll') { pollSubs(); cwTimer = setInterval(pollSubs, cwPollMs); if (cwTimer.unref) cwTimer.unref(); }
  }
  function stop() { if (timer) clearInterval(timer); if (cwTimer) clearInterval(cwTimer); }
  // Synchronous check (memory only) — used at decide, before POST and before confirm.
  function blockReason(rfq) {
    if (isStale()) {
      if (failClosed) return 'locks_unknown';
      stats.staleChecks += 1;
      if (now() - lastWarn >= warnEveryMs) { lastWarn = now(); log(`[SNIPER] WARN locks stale (ageMs=${at ? now() - at : 'never'}, locks=${locks.length}) — quoting against last loaded list`); }
    }
    if (matchParlay(rfq, locks)) return 'combo_lock_match';
    if (skipOverlap && lockLegOverlap(rfq, locks) > 0) return 'overlaps_combo_lock';
    return null;
  }
  function unknownSubs() { if (failClosed) return 'submissions_unknown'; stats.submissionsUnknown += 1; return null; }
  // Async check against combo-worker's live submissions for this RFQ (read-only).
  async function comboWorkerQuoting(rfqId) {
    if (cwMode === 'poll') {
      if (!cwAt || now() - cwAt > Math.max(5000, cwPollMs * 10)) return unknownSubs();
      return cwLive.has(rfqId) ? 'combo_worker_quoting' : null;
    }
    try {
      // Bounded: this query is on the quote hot path. A slow answer is treated like an unknown one.
      let timer;
      const q = supabase.from('combo_submissions').select('quote_id').eq('rfq_id', rfqId).eq('is_live', true).limit(1);
      const r = await Promise.race([q, new Promise((res) => { timer = setTimeout(() => res({ timedOut: true }), cwTimeoutMs); })]);
      clearTimeout(timer);
      if (r && r.timedOut) { stats.cwTimeouts = (stats.cwTimeouts || 0) + 1; return unknownSubs(); }
      const { data, error } = r;
      if (error) return unknownSubs();
      return (data && data.length) ? 'combo_worker_quoting' : null;
    } catch (_) { return unknownSubs(); }
  }
  function setLocks(l, t = now()) { locks = l; at = t; }
  function _setSubs(ids, t = now()) { cwLive = new Set(ids); cwAt = t; } // tests
  const pollSubsNow = pollSubs; // tests
  return { start, stop, poll, pollSubs: pollSubsNow, _setSubs, blockReason, comboWorkerQuoting, setLocks, stats: () => ({ ...stats, locks: locks.length, ageMs: at ? now() - at : null, locksStale: isStale(), failClosed }) };
}

module.exports = { createLockCoord };
