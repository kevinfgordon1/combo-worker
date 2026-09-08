// Process split: Combo Locks and Unhedged RFQs are separate Railway jobs.
//
// WORKER_MODE:
//   combo     (default) — live-runner / start-live.js. Kalshi + Poly locks only.
//   unhedged            — unhedged-runner / start-unhedged.js. Paper tape only.
//   all                 — escape hatch: one process does both (local / rollback).
//
// Default is combo so an existing Railway start command (npm start) no longer
// schedules unhedged /markets refresh, fill ticks, or shadow-miss work.
// UNHEDGED_RFQ_LIVE stays off on every path. Quote-watcher stays parked.
'use strict';

const WORKER_MODE_COMBO = 'combo';
const WORKER_MODE_UNHEDGED = 'unhedged';
const WORKER_MODE_ALL = 'all';

const COMBO_ALIASES = new Set(['combo', 'locks', 'combo_locks', 'live']);
const UNHEDGED_ALIASES = new Set(['unhedged', 'unhedged_rfq', 'rfq']);
const ALL_ALIASES = new Set(['all', 'both', 'combined']);

function resolveWorkerMode(env = process.env) {
  const raw = env && env.WORKER_MODE;
  if (raw == null || String(raw).trim() === '') return WORKER_MODE_COMBO;
  const s = String(raw).trim().toLowerCase();
  if (UNHEDGED_ALIASES.has(s)) return WORKER_MODE_UNHEDGED;
  if (ALL_ALIASES.has(s)) return WORKER_MODE_ALL;
  if (COMBO_ALIASES.has(s)) return WORKER_MODE_COMBO;
  return WORKER_MODE_COMBO;
}

function shouldRunComboLocks(env = process.env) {
  const mode = resolveWorkerMode(env);
  return mode === WORKER_MODE_COMBO || mode === WORKER_MODE_ALL;
}

function shouldRunUnhedged(env = process.env) {
  const mode = resolveWorkerMode(env);
  return mode === WORKER_MODE_UNHEDGED || mode === WORKER_MODE_ALL;
}

module.exports = {
  WORKER_MODE_COMBO,
  WORKER_MODE_UNHEDGED,
  WORKER_MODE_ALL,
  resolveWorkerMode,
  shouldRunComboLocks,
  shouldRunUnhedged,
};
