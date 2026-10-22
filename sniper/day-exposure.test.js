'use strict';
// Daily cap counts filled cost only; in-memory day tracker survives reload (no first-prune zeroing).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createSniperLedger } = require('../auto-sniper');
const { createLedgerStore } = require('./ledger-store');

(async () => {
  // 1) setDayExposure marks today, so the next prune() does not zero it.
  const L = createSniperLedger({ dayRiskOnAdd: false });
  const now = Date.parse('2026-10-22T19:00:00Z');
  L.setDayExposure({ filled: 399.76, pending: 923.5, fills: 14 }, now);
  L.prune(now + 1000);
  assert.strictEqual(L.day.risk, 399.76);
  assert.strictEqual(L.day.pending, 923.5);
  assert.strictEqual(L.day.fills, 14);
  // new quotes do not count toward the daily (filled) number
  L.add('r1', { combo: 'c', games: ['g'], legs: ['l'], risk: 100, releaseAt: now + 6e4 }, now + 2000);
  assert.strictEqual(L.day.risk, 399.76);
  assert.strictEqual(L.totals().total, 100); // still bounded by total/game/leg caps
  // next ET day resets
  L.prune(Date.parse('2026-10-23T05:00:00Z'));
  assert.strictEqual(L.day.risk, 0);
  assert.strictEqual(L.day.pending, 0);
  // legacy default still counts on add
  const D = createSniperLedger();
  D.add('r', { combo: 'c', games: [], legs: [], risk: 50, releaseAt: now + 6e4 }, now);
  assert.strictEqual(D.day.risk, 50);

  // 2) hydrate pulls day totals from sniper_day_exposure (same function as the DB cap), not open risk.
  const rows = [
    { rfq_id: 'a', combo_key: 'A', games: ['g'], legs: ['x'], risk: 30, phase: 'filled', release_at: new Date(now - 1e3).toISOString(), created_at: '2026-10-22T17:00:00Z' },
    { rfq_id: 'b', combo_key: 'B', games: ['g'], legs: ['y'], risk: 90, phase: 'quoted', release_at: new Date(Date.now() + 6e5).toISOString(), created_at: '2026-10-22T18:00:00Z' },
  ];
  const calls = [];
  const q = { select() { return q; }, eq() { return q; }, limit: async () => ({ data: rows, error: null }) };
  const supabase = {
    from: () => q,
    rpc: async (fn, args) => { calls.push([fn, args]); return { data: { filled: 30, fills: 1, pending: 90 }, error: null }; },
  };
  const store = createLedgerStore({ supabase, log: () => {} });
  const H = createSniperLedger({ dayRiskOnAdd: false });
  await store.hydrate(H, '2026-10-22T04:00:00.000Z', { live: true });
  assert.deepStrictEqual(calls[0], ['sniper_day_exposure', { p_day_start: '2026-10-22T04:00:00.000Z', p_live: true }]);
  assert.strictEqual(H.day.risk, 30);
  assert.strictEqual(H.day.pending, 90);
  assert.ok(H.day.key, 'day key set on reload');
  const key = H.day.key; H.prune(Date.now()); assert.strictEqual(H.day.key, key); assert.strictEqual(H.day.risk, 30);

  // dayExposure fails loudly on DB error (caller logs; DB cap is still authoritative)
  const bad = createLedgerStore({ supabase: { from: () => q, rpc: async () => ({ data: null, error: { message: 'x' } }) }, log: () => {} });
  await assert.rejects(() => bad.dayExposure('2026-10-22T04:00:00.000Z', { live: true }), /day exposure/);

  // 3) Migration: the daily cap reads filled cost via sniper_day_exposure; other caps unchanged.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20261022_sniper_daily_filled_cap.sql'), 'utf8');
  assert.match(sql, /sum\(filled_cost\)/);
  assert.match(sql, /sniper_day_exposure\(d, lv\)->>'filled'/);
  assert.match(sql, /'total_cap'/); assert.match(sql, /'game_cap'/); assert.match(sql, /'leg_cap'/);
  assert.doesNotMatch(sql, /created_at >= d and phase not in/);
  console.log('day-exposure tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
