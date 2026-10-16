// User-requested cancel of open Combo Locks quotes.
//
// Signals (written by aibetbuilder /api/combo-lock-orders):
//   combo_parlays.cancel_open_at     — cancel all open quotes for that lock
//   combo_submissions.cancel_requested_at — cancel that one open quote
//
// Poll every ~2s (same cadence as pause). Matched fills are never cancelled:
// only is_live / in-memory pending quotes are touched. Missing columns
// (migration not applied) disable the poller quietly.
'use strict';

const COL_ERR = /Could not find the '([^']+)' column|column [\w."]*(cancel_open_at|cancel_requested_at)[\w."]* does not exist/i;

function createUserCancelPoller({ supabase, log = () => {} } = {}) {
  let columnMissing = false;
  /** @type {Map<string, string>} parlayId -> last handled cancel_open_at ISO */
  const handledOpen = new Map();
  /** @type {Set<string>} submission ids already handed to cancel */
  const handledSubs = new Set();

  return {
    get disabled() { return columnMissing; },
    /** @returns {{ parlayIds: string[], submissions: object[] } | null} */
    async poll() {
      if (columnMissing || !supabase) return null;
      try {
        const [parlaysRes, subsRes] = await Promise.all([
          supabase.from('combo_parlays').select('id,cancel_open_at').eq('active', true).not('cancel_open_at', 'is', null),
          supabase.from('combo_submissions')
            .select('id,parlay_id,quote_id,rfq_id,label,venue,is_live,cancel_requested_at,user_id')
            .eq('is_live', true)
            .not('cancel_requested_at', 'is', null),
        ]);
        if (parlaysRes && parlaysRes.error) {
          if (COL_ERR.test(String(parlaysRes.error.message || ''))) {
            columnMissing = true;
            log('[USER-CANCEL] cancel columns missing — user cancel disabled until migration');
            return null;
          }
          return null;
        }
        if (subsRes && subsRes.error) {
          if (COL_ERR.test(String(subsRes.error.message || ''))) {
            columnMissing = true;
            log('[USER-CANCEL] cancel columns missing — user cancel disabled until migration');
            return null;
          }
          return null;
        }

        const parlayIds = [];
        for (const row of (parlaysRes && parlaysRes.data) || []) {
          if (!row || !row.id || !row.cancel_open_at) continue;
          const prev = handledOpen.get(row.id);
          if (prev === row.cancel_open_at) continue;
          handledOpen.set(row.id, row.cancel_open_at);
          parlayIds.push(row.id);
        }

        const submissions = [];
        for (const row of (subsRes && subsRes.data) || []) {
          if (!row || !row.id || handledSubs.has(row.id)) continue;
          if (!row.quote_id) continue;
          handledSubs.add(row.id);
          submissions.push(row);
        }
        if (!parlayIds.length && !submissions.length) return { parlayIds: [], submissions: [] };
        return { parlayIds, submissions };
      } catch (_) {
        return null;
      }
    },
  };
}

module.exports = { createUserCancelPoller };
