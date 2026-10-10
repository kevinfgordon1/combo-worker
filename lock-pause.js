// Per-lock pause (combo_parlays.paused). A paused lock stays in the table with
// its fills and history, but the worker stops matching/quoting it on Kalshi AND
// Polymarket and cancels its open quotes. Independent of the global kill switch.
//
// Backward compatible: when the `paused` column does not exist yet (migration
// sql/20261002_combo_parlays_paused.sql not applied) every lock counts as
// enabled and the poller turns itself off.
'use strict';

const COL_ERR = /Could not find the '([^']+)' column|column [\w."]*paused[\w."]* does not exist/i;
const HOLD_COL_ERR = /Could not find the 'probe_hold_until' column|column [\w."]*probe_hold_until[\w."]* does not exist/i;

// "Check market price" on a pending lock writes combo_parlays.probe_hold_until
// (now + ~20s). While that is in the future the lock is treated as paused so
// its own quotes are cancelled and it does not compete with the probe.
// Safety net: the worker never honors one hold for more than PROBE_HOLD_MAX_MS
// after it first saw it, nor an `until` further out than that — a crashed
// probe or a bad timestamp can never leave a lock dark.
const PROBE_HOLD_MAX_MS = 30000;

function createProbeHolds({ maxMs = PROBE_HOLD_MAX_MS } = {}) {
  /** @type {Map<string, {until: string, firstSeen: number}>} */
  const seen = new Map();
  return {
    maxMs,
    /** true while this row's probe hold is active (bounded by maxMs). */
    isHeld(row, now = Date.now()) {
      if (!row || !row.id) return false;
      const raw = row.probe_hold_until;
      if (!raw) { seen.delete(row.id); return false; }
      const until = Date.parse(raw);
      if (!Number.isFinite(until) || until <= now) { seen.delete(row.id); return false; }
      let rec = seen.get(row.id);
      if (!rec || rec.until !== raw) { rec = { until: raw, firstSeen: now }; seen.set(row.id, rec); }
      return now - rec.firstSeen < maxMs;
    },
    _seen: seen,
  };
}

const defaultHolds = createProbeHolds();

function isPaused(row, now = Date.now(), holds = defaultHolds) {
  if (!row) return false;
  if (row.paused === true) return true;
  return !!holds && holds.isHeld(row, now);
}

// { live, pausedIds } from a list of combo_parlays rows (select('*')).
function splitPaused(rows, now = Date.now(), holds = defaultHolds) {
  const live = [];
  const pausedIds = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isPaused(row, now, holds)) pausedIds.add(row.id);
    else live.push(row);
  }
  return { live, pausedIds };
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
function createPausePoller({ supabase, log = () => {}, holds = defaultHolds, now = () => Date.now() } = {}) {
  let columnMissing = false;
  let holdColMissing = false;
  return {
    get disabled() { return columnMissing; },
    // Returns a Set of paused parlay ids, or null (column missing / read failed).
    async poll() {
      if (columnMissing || !supabase) return null;
      try {
        let res = await supabase.from('combo_parlays')
          .select(holdColMissing ? 'id,paused' : 'id,paused,probe_hold_until').eq('active', true);
        if (res && res.error && !holdColMissing && HOLD_COL_ERR.test(String(res.error.message || ''))) {
          holdColMissing = true;
          log('[PAUSE] combo_parlays.probe_hold_until not found — Check market price holds disabled');
          res = await supabase.from('combo_parlays').select('id,paused').eq('active', true);
        }
        if (res && res.error) {
          if (COL_ERR.test(String(res.error.message || ''))) {
            columnMissing = true;
            log('[PAUSE] combo_parlays.paused column not found — all locks treated as enabled');
          }
          return null;
        }
        const ids = new Set();
        const t = now();
        for (const row of (res && res.data) || []) if (isPaused(row, t, holds)) ids.add(row.id);
        return ids;
      } catch (_) {
        return null;
      }
    },
  };
}

module.exports = { PROBE_HOLD_MAX_MS, createProbeHolds, isPaused, splitPaused, diffPaused, createPausePoller };
