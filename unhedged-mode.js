// Process-split flags for Combo Locks vs Unhedged RFQ shadow.
//
// Combo Locks (live-runner) stays one worker with Kalshi + Polymarket on the
// latency-critical path. Unhedged markets GETs, shadow tape, and fill tracking
// belong on unhedged-runner.js once the second Railway service exists.
//
// Ship-before-second-service: UNHEDGED_IN_PROCESS defaults ON so the existing
// combo-worker still writes unhedged_rfqs. After the Unhedged job is up, set
// UNHEDGED_IN_PROCESS=0 (or WORKER_ROLE=locks) on Combo Locks.
//
// UNHEDGED_RFQ_LIVE stays off — this module never enables live unhedged POSTs.
'use strict';

function envFlag(v, defaultOn) {
  if (v == null || String(v).trim() === '') return defaultOn;
  const s = String(v).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  return defaultOn;
}

function workerRole(env = process.env) {
  const raw = env && (env.WORKER_ROLE || env.COMBO_WORKER_ROLE);
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'locks' || s === 'combo' || s === 'combo-locks' || s === 'combo_locks') {
    return 'locks';
  }
  if (s === 'unhedged') return 'unhedged';
  if (s === 'all' || s === 'combined' || s === 'both') return 'all';
  return 'all';
}

// Combined process: default ON. WORKER_ROLE=locks forces off.
function isUnhedgedInProcess(env = process.env) {
  const role = workerRole(env);
  if (role === 'locks') return false;
  if (role === 'unhedged') return true;
  return envFlag(env && env.UNHEDGED_IN_PROCESS, true);
}

function isLocksOnly(env = process.env) {
  return !isUnhedgedInProcess(env);
}

module.exports = {
  envFlag,
  workerRole,
  isUnhedgedInProcess,
  isLocksOnly,
};
