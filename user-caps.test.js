'use strict';
const assert = require('assert');
const { createUserCaps, etDayStartIso } = require('./user-caps');
const { createLiveUserGate } = require('./live-users');
const { resolveWorkerScope } = require('./worker-scope');

const KEVIN = '79ae1610-097e-4b46-a622-1e952f18e936';
const T = '11111111-2222-4333-8444-555555555555';

// ET midnight: 2026-10-07 15:00 EDT => 2026-10-07T04:00Z; Jan (EST) => 05:00Z.
assert.strictEqual(etDayStartIso(new Date('2026-10-07T19:00:00Z')), '2026-10-07T04:00:00.000Z');
assert.strictEqual(etDayStartIso(new Date('2026-10-08T02:30:00Z')), '2026-10-07T04:00:00.000Z');
assert.strictEqual(etDayStartIso(new Date('2026-01-15T12:00:00Z')), '2026-01-15T05:00:00.000Z');

const cost = (row) => row.cost; // test locks carry their NO price directly

function fakeSupabase(rows, { fail = false } = {}) {
  const calls = [];
  const q = {
    select() { return q; }, in(c, v) { calls.push(['in', c, v]); return q; }, eq() { return q; },
    gte(c, v) { calls.push(['gte', c, v]); return Promise.resolve(fail ? { data: null, error: { message: 'boom' } } : { data: rows, error: null }); },
  };
  return { calls, from: (t) => { calls.push(['from', t]); return q; } };
}

(async () => {
  // Kevin (main worker, NULL caps): rows untouched, never blocked, no DB read.
  {
    const gate = createLiveUserGate({ env: {}, log: () => {} });
    gate.apply({ data: [{ user_id: KEVIN, can_trade: true, paused: false, max_per_lock_usd: null, max_per_day_usd: null }], error: null });
    const caps = createUserCaps({ gate, costFor: cost, log: () => {} });
    const rows = [{ id: 'k', user_id: KEVIN, cost: 0.9, max_contracts: 0 }];
    assert.strictEqual(caps.applyLockCaps(rows)[0], rows[0]);
    const sb = fakeSupabase([]);
    assert.strictEqual(await caps.refreshDay({ supabase: sb, parlays: rows }), true);
    assert.strictEqual(sb.calls.length, 0, 'no fills read for uncapped users');
    assert.strictEqual(caps.dayBlocked(KEVIN, { parlays: rows }), false);
  }

  const scope = resolveWorkerScope({ COMBO_WORKER_USER_ID: T });
  const gate = createLiveUserGate({ env: {}, scope, log: () => {} });
  gate.apply({ data: [{ user_id: T, can_trade: true, paused: false, max_per_lock_usd: 50, max_per_day_usd: 250 }], error: null });
  const logs = [];
  const caps = createUserCaps({ gate, costFor: cost, log: (m) => logs.push(m), now: () => new Date('2026-10-07T19:00:00Z') });

  // Per lock: $50 at $0.40/contract => 125 contracts; tighter lock limit kept;
  // 0 (= unlimited) clamped; a lock priced over $50/contract can't happen (<=1),
  // so test the drop with a $0.30 cap.
  {
    const rows = [
      { id: 'a', user_id: T, cost: 0.4, max_contracts: 0 },
      { id: 'b', user_id: T, cost: 0.4, max_contracts: 20 },
      { id: 'c', user_id: T, cost: 0.4, max_contracts: 500 },
    ];
    const out = caps.applyLockCaps(rows);
    assert.deepStrictEqual(out.map((r) => r.max_contracts), [125, 20, 125]);
    assert.strictEqual(rows[0].max_contracts, 0, 'input rows not mutated');
    const g2 = createLiveUserGate({ env: {}, scope, log: () => {} });
    g2.apply({ data: [{ user_id: T, can_trade: true, paused: false, max_per_lock_usd: 0.3, max_per_day_usd: 250 }], error: null });
    const c2 = createUserCaps({ gate: g2, costFor: cost, log: (m) => logs.push(m) });
    assert.deepStrictEqual(c2.applyLockCaps([{ id: 'd', user_id: T, cost: 0.5, max_contracts: 0 }]), []);
    c2.applyLockCaps([{ id: 'd', user_id: T, cost: 0.5, max_contracts: 0 }]);
    assert.strictEqual(logs.filter((l) => /lock d .*dropped/.test(l)).length, 1, 'logged once');
  }

  // Tester before combo_live_users read: caps 0 => every lock dropped.
  {
    const g0 = createLiveUserGate({ env: {}, scope, log: () => {} });
    const c0 = createUserCaps({ gate: g0, costFor: cost, log: () => {} });
    assert.deepStrictEqual(c0.applyLockCaps([{ id: 'x', user_id: T, cost: 0.5, max_contracts: 0 }]), []);
  }

  // Per day: fails closed until today's fills are read.
  const locks = caps.applyLockCaps([
    { id: 'a', user_id: T, cost: 0.4, max_contracts: 0 }, // capped to 125 => $50 room
    { id: 'b', user_id: T, cost: 0.5, max_contracts: 20 }, // $10 room
  ]);
  assert.strictEqual(caps.dayBlocked(T, { parlays: locks }), true, 'not read yet => blocked');
  {
    const sb = fakeSupabase([], { fail: true });
    assert.strictEqual(await caps.refreshDay({ supabase: sb, parlays: locks }), false);
    assert.strictEqual(caps.dayBlocked(T, { parlays: locks }), true);
  }
  // $150 filled today on lock a (375 contracts x 0.4): 150 + next $50 = 200 <= 250 ok.
  let filled = { a: 0, b: 0 };
  const sb = fakeSupabase([{ parlay_id: 'a', count: 375, user_id: T }]);
  assert.strictEqual(await caps.refreshDay({ supabase: sb, parlays: locks, filledSoFarFor: (id) => filled[id] }), true);
  assert.deepStrictEqual(sb.calls.find((c) => c[0] === 'in'), ['in', 'user_id', [T]], 'only this user\'s fills');
  assert.deepStrictEqual(sb.calls.find((c) => c[0] === 'gte'), ['gte', 'recorded_at', '2026-10-07T04:00:00.000Z']);
  assert.strictEqual(caps.dayUsed(T), 150);
  const opts = (o = {}) => ({ parlays: locks, filledSoFarFor: (id) => filled[id], outstandingFor: (id) => (o[id] || 0) });
  assert.strictEqual(caps.dayBlocked(T, opts()), false);
  // Open quotes reserve: 100 contracts on a ($40) => 150 + 40 + next max(a 25x0.4=$10, b $10) = 200 ok.
  assert.strictEqual(caps.dayBlocked(T, opts({ a: 100 })), false);
  // Session fills since the read count: a filled 120 more ($48) + b open 20 ($10)
  // => 150 + 48 + 10 + next a 5x0.4=$2 = 210 ok.
  filled = { a: 120, b: 0 };
  assert.strictEqual(caps.dayBlocked(T, opts({ b: 20 })), false);
  // Re-read: $235 confirmed today (375x0.4 + 170x0.5). Snapshot resets session delta.
  const sb2 = fakeSupabase([{ parlay_id: 'a', count: 375, user_id: T }, { parlay_id: 'b', count: 170, user_id: T }]);
  await caps.refreshDay({ supabase: sb2, parlays: locks, filledSoFarFor: (id) => filled[id] });
  assert.strictEqual(caps.dayUsed(T), 235);
  // 235 + next max(a 5x0.4=$2, b 20x0.5=$10) = 245 ok; one open contract on a ($0.4) still ok;
  assert.strictEqual(caps.dayBlocked(T, opts({})), false);
  // a fills 5 more in-session ($2) and b has 12 open ($6): 237 + 6 + next b 8x0.5=$4 = 247 ok
  filled = { a: 125, b: 0 };
  assert.strictEqual(caps.dayBlocked(T, opts({ b: 12 })), false);
  // Lock c has $15 room: 237 + 15 = 252 > 250 => quoting c is refused before
  // it is sent, but b ($10 room => 247) can still quote.
  const big = locks.concat([{ id: 'c', user_id: T, cost: 0.5, max_contracts: 30 }]);
  const bo = { parlays: big, filledSoFarFor: (id) => filled[id] || 0, outstandingFor: () => 0 };
  assert.strictEqual(caps.dayBlocked(T, bo), true, 'no lock given => largest room');
  assert.strictEqual(caps.dayBlocked(T, { ...bo, lock: big[2] }), true);
  assert.strictEqual(caps.dayBlocked(T, { ...bo, lock: big[1] }), false);
  // Other users never blocked by T's spending.
  assert.strictEqual(caps.dayBlocked(KEVIN, opts({})), false);
  console.log('user-caps tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
