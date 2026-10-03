// Per-lock pause (combo_parlays.paused). A paused lock stays in the table with
// its fills and history, but the worker stops matching/quoting it on Kalshi AND
// Polymarket and cancels its open quotes. Independent of the global kill switch.
//
// Backward compatible: when the `paused` column does not exist yet (migration
// sql/20261002_combo_parlays_paused.sql not applied) every lock counts as
// enabled and the poller turns itself off.
'use strict';

const COL_ERR = /Could not find the '([^']+)' column|column [\w."]*paused[\w."]* does not exist/i;

function isPaused(row) {
  return !!row && row.paused === true;
}

// { live, pausedIds } from a list of combo_parlays rows (select('*')).
function splitPaused(rows) {
  const live = [];
  const pausedIds = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isPaused(row)) pausedIds.add(row.id);
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
function createPausePoller({ supabase, log = () => {} } = {}) {
  let columnMissing = false;
  return {
    get disabled() { return columnMissing; },
    // Returns a Set of paused parlay ids, or null (column missing / read failed).
    async poll() {
      if (columnMissing || !supabase) return null;
      try {
        const res = await supabase.from('combo_parlays').select('id,paused').eq('active', true);
        if (res && res.error) {
          if (COL_ERR.test(String(res.error.message || ''))) {
            columnMissing = true;
            log('[PAUSE] combo_parlays.paused column not found — all locks treated as enabled');
          }
          return null;
        }
        const ids = new Set();
        for (const row of (res && res.data) || []) if (isPaused(row)) ids.add(row.id);
        return ids;
      } catch (_) {
        return null;
      }
    },
  };
}

module.exports = { isPaused, splitPaused, diffPaused, createPausePoller };
