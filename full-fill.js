'use strict';
// Full-fill deactivation gate. A Combo Lock is only switched off (active=false)
// as "fully hedged" when CONFIRMED Kalshi/Polymarket fills stored in combo_fills
// reach the lock's cap. Offered, accepted or quoted sizes (and in-memory session
// counters built from them) never deactivate a lock.
const { countsTowardCap } = require('./fills-attr');
const { isNonPrimarySubaccount } = require('./sniper-guard');

function isComboLocksCapRow(row) {
  if (!row || row.is_combo !== true) return false;
  // #195: sniper / numbered-subaccount fills are never Combo Locks fills.
  if (isNonPrimarySubaccount(row) || isNonPrimarySubaccount(row.raw)) return false;
  return countsTowardCap(row);
}

function sumConfirmedForCap(rows) {
  let t = 0;
  for (const r of rows || []) {
    if (!isComboLocksCapRow(r)) continue;
    const n = Number(r.count);
    if (Number.isFinite(n)) t += n;
  }
  return Math.round(t * 1e6) / 1e6;
}

// Returns { full, confirmed, reason }. Any read failure => full:false (never
// deactivate on doubt; the in-memory cap still blocks over-quoting).
async function confirmedFullFill({ supabase, parlayId, ceiling }) {
  const cap = Number(ceiling);
  if (!parlayId || !(cap > 0)) return { full: false, confirmed: null, reason: 'no-cap' };
  try {
    const { data, error } = await supabase
      .from('combo_fills')
      .select('parlay_id,count,fill_id,order_id,is_combo,is_taker,raw')
      .eq('parlay_id', parlayId)
      .eq('is_combo', true)
      .eq('is_taker', false);
    if (error || !Array.isArray(data)) return { full: false, confirmed: null, reason: 'read-failed' };
    const confirmed = sumConfirmedForCap(data);
    return { full: confirmed + 1e-9 >= cap, confirmed, reason: 'db' };
  } catch (_) {
    return { full: false, confirmed: null, reason: 'read-failed' };
  }
}

module.exports = { isComboLocksCapRow, sumConfirmedForCap, confirmedFullFill };
