'use strict';
// Oct 25 2026 resting-quote controls: weight in in-memory caps, committed-only stays full, caps payload.
const test = require('node:test'); const assert = require('node:assert');
const { createSniperLedger } = require('../auto-sniper');
const { capsFrom } = require('./ledger-store');

test('resting quotes count at restingWeight; committed at full', () => {
  const L = createSniperLedger({ dayRiskOnAdd: false });
  L.positions.set('f', { combo: 'a', games: ['g1'], legs: ['l1'], risk: 5000, releaseAt: Infinity });
  L.positions.set('q', { combo: 'b', games: ['g1'], legs: ['l2'], risk: 4800, releaseAt: Infinity, resting: true });
  assert.strictEqual(L.totals().total, 9800); // default weight 1 = old behaviour
  L.restingWeight = 0.5;
  const t = L.totals();
  assert.strictEqual(t.total, 7400); assert.strictEqual(t.games.get('g1'), 7400);
  assert.strictEqual(t.committed, 5000); assert.strictEqual(t.resting, 4800);
  L.positions.get('q').resting = false; // accepted -> full
  assert.strictEqual(L.totals().total, 9800);
  L.restingWeight = 7; assert.strictEqual(L.totals().total, 9800); // clamped to 1
});
test('capsFrom sends resting_weight + reserve_lock (old SQL ignores them)', () => {
  const c = capsFrom({ totalExposureCap: 10000, restingCapWeight: 0.5, reserveLock: 'combo' }, '2026-10-25T04:00:00Z', true);
  assert.strictEqual(c.resting_weight, 0.5); assert.strictEqual(c.reserve_lock, 'combo');
  const d = capsFrom({ totalExposureCap: 10000 }, 'x', true);
  assert.strictEqual(d.resting_weight, 1); assert.strictEqual(d.reserve_lock, 'global');
});
