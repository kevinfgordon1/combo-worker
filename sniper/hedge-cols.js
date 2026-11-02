// Tolerate the hedge-cost columns (hedge, hedge_prob, hedge_roi, hedge_fill) not existing yet.
// Until migrations/20261102_sniper_hedge_cost_log.sql is run, the first write that PostgREST rejects
// for a missing hedge column turns them off for that table (for the life of the process) and the
// same write is retried without them, so the row itself is never lost. Log-only data, nothing else.
'use strict';

const HEDGE_COLS = ['hedge', 'hedge_prob', 'hedge_roi', 'hedge_fill'];
const off = new Set(); // table names whose hedge columns are known missing
const logged = new Set();

const hedgeColsOn = (table) => !off.has(table);
function hasHedgeCols(obj) { return !!obj && HEDGE_COLS.some((k) => k in obj); }
function stripHedgeCols(obj) {
  if (!hasHedgeCols(obj)) return obj;
  const out = { ...obj };
  for (const k of HEDGE_COLS) delete out[k];
  return out;
}
// PostgREST: "Could not find the 'hedge' column of 'sniper_ledger' in the schema cache" (PGRST204);
// Postgres: column "hedge_roi" of relation ... does not exist (42703).
function isMissingHedgeCol(error) {
  if (!error) return false;
  const m = String(error.message || '') + ' ' + String(error.details || '') + ' ' + String(error.hint || '');
  return /hedge(_prob|_roi|_fill)?/i.test(m) && /(column|schema cache)/i.test(m);
}
function disableHedgeCols(table, log = console.log) {
  off.add(table);
  if (!logged.has(table)) { logged.add(table); try { log(`[HEDGE-LOG] ${table} hedge columns missing: writing rows without them (run migrations/20261102_sniper_hedge_cost_log.sql, then redeploy)`); } catch (_) { /* ignore */ } }
}
// Prepare a row / patch for `table`: drop hedge fields when the columns are known missing.
const forTable = (table, obj) => (hedgeColsOn(table) ? obj : stripHedgeCols(obj));

// Run write(obj); if it fails only because a hedge column is missing, turn them off and retry once without.
async function writeTolerant(table, obj, write, log) {
  const first = forTable(table, obj);
  const res = await write(first);
  if (res && res.error && hasHedgeCols(first) && isMissingHedgeCol(res.error)) {
    disableHedgeCols(table, log);
    return write(stripHedgeCols(first));
  }
  return res;
}

function _resetHedgeCols() { off.clear(); logged.clear(); }

module.exports = { HEDGE_COLS, hedgeColsOn, hasHedgeCols, stripHedgeCols, isMissingHedgeCol, disableHedgeCols, forTable, writeTolerant, _resetHedgeCols };
