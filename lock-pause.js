// Per-lock pause (combo_parlays.paused). A paused lock stays in the table with
// its fills and history, but the worker stops matching/quoting it on Kalshi AND
// Polymarket and cancels its open quotes. Independent of the global kill switch.
//
// Backward compatible: when the `paused` column does not exist yet (migration
// sql/20261002_combo_parlays_paused.sql not applied) every lock counts as
// enabled and the poller turns itself off.
'use strict';

const COL_ERR = /Could not find the '([^']+)' column|column [\w."]*paused[\w."]* does not exist/i;
const PROBE_COL_ERR = /probe_pause(d_at|_until)/i;

// "Check market price" on a pending lock (aibetbuilder api/combo-probe { lockId }) stamps
// probe_paused_at / probe_pause_until while it RFQs the lock's combo for 10s. The lock is
// treated as paused only while now < probe_pause_until AND now - probe_paused_at <= 30s:
// a crashed / timed-out check can never leave a lock dark for more than ~30s.
const PROBE_PAUSE_MAX_MS = 30_000;

/** ms epoch the probe pause ends (safety-capped), or null when no live probe pause. */
function probePauseEnd(row, now = Date.now()) {
  if (!row || !row.probe_pause_until) return null;
  const until = Date.parse(row.probe_pause_until);
  if (!Number.isFinite(until)) return null;
  const at = row.probe_paused_at ? Date.parse(row.probe_paused_at) : NaN;
  // No start stamp → cap from now, so a stray far-future value still can't pin the lock.
  const cap = Number.isFinite(at) ? at + PROBE_PAUSE_MAX_MS : now + PROBE_PAUSE_MAX_MS;
  const end = Math.min(until, cap);
  return now < end ? end : null;
}

function isManuallyPaused(row) {
  return !!row && row.paused === true;
}

function isPaused(row, now = Date.now()) {
  return isManuallyPaused(row) || probePauseEnd(row, now) != null;
}

// { live, pausedIds, probeUntil } from a list of combo_parlays rows (select('*')).
// probeUntil: id -> end ms for locks paused only by a market check.
function splitPaused(rows, now = Date.now()) {
  const live = [];
  const pausedIds = new Set();
  const probeUntil = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isPaused(row, now)) {
      pausedIds.add(row.id);
      if (!isManuallyPaused(row)) probeUntil.set(row.id, probePauseEnd(row, now));
    } else live.push(row);
  }
  return { live, pausedIds, probeUntil };
}

// Local safety net: probe-only pauses whose end has passed (even if the DB poll is failing).
function expiredProbePauses(pausedIds, probeUntil, now = Date.now()) {
  const out = [];
  for (const [id, end] of probeUntil || []) if (pausedIds.has(id) && !(now < end)) out.push(id);
  return out;
}

function diffPaused(prev, next) {
  const pausedNow = [];
  const resumed = [];
  for (const id of next) if (!prev.has(id)) pausedNow.push(id);
  for (const id of prev) if (!next.has(id)) resumed.push(id);
  return { pausedNow, resumed };
}

// Fast poll of {id, paused} for active locks so a toggle takes effect in
// seconds instead of waiting for the 30s refresh.
function createPausePoller({ supabase, log = () => {}, now = () => Date.now() } = {}) {
  let columnMissing = false;
  let probeColsMissing = false;
  return {
    get disabled() { return columnMissing; },
    // Returns a Set of paused parlay ids (with .probeUntil Map), or null (column missing / read failed).
    async poll() {
      if (columnMissing || !supabase) return null;
      try {
        const cols = probeColsMissing ? 'id,paused' : 'id,paused,probe_paused_at,probe_pause_until';
        const res = await supabase.from('combo_parlays').select(cols).eq('active', true);
        if (res && res.error) {
          const msg = String(res.error.message || '');
          if (!probeColsMissing && PROBE_COL_ERR.test(msg)) {
            probeColsMissing = true;
            log('[PAUSE] combo_parlays.probe_pause_* columns not found — market-check pauses ignored');
            return this.poll();
          }
          if (COL_ERR.test(msg)) {
            columnMissing = true;
            log('[PAUSE] combo_parlays.paused column not found — all locks treated as enabled');
          }
          return null;
        }
        const split = splitPaused((res && res.data) || [], now());
        const ids = split.pausedIds;
        ids.probeUntil = split.probeUntil;
        return ids;
      } catch (_) {
        return null;
      }
    },
  };
}

module.exports = {
  isPaused, isManuallyPaused, probePauseEnd, splitPaused, expiredProbePauses, diffPaused, createPausePoller, PROBE_PAUSE_MAX_MS,
};
