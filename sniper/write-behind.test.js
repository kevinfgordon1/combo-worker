'use strict';
const assert = require('assert');
const { createWriteBehindStore, memoryCapReason, isLongPos } = require('./write-behind');

(async () => {
  // ordering: update/confirm run after reserve lands; reserve returns synchronously
  const ops = [];
  const slow = { reserve: async (d) => { await new Promise((r) => setTimeout(r, 30)); ops.push(`reserve:${d.rfqId}`); return { ok: true }; },
    update: async (id) => { ops.push(`update:${id}`); return true; }, release: async (id) => { ops.push(`release:${id}`); return true; },
    confirmCheck: async (id) => { ops.push(`confirm:${id}`); return { ok: true }; } };
  const wb = createWriteBehindStore(slow, { log: () => {} });
  const t0 = Date.now(); const r = wb.reserve({ rfqId: 'A' }, {}); assert.ok(r.ok); assert.ok(Date.now() - t0 < 10);
  const u = wb.update('A', {}); const c = wb.confirmCheck('A', 1, {});
  await Promise.all([u, c, r.pending]);
  assert.deepStrictEqual(ops, ['reserve:A', 'update:A', 'confirm:A']);

  // retries on db_error, then fail closed: callback fired, confirm refused, release is no-op
  let n = 0; const failedCalls = []; const alerts = [];
  const bad = { reserve: async () => { n += 1; return { ok: false, reason: 'db_error' }; }, update: async () => { throw new Error('nope'); }, release: async () => { throw new Error('nope'); }, confirmCheck: async () => ({ ok: true }) };
  const wb2 = createWriteBehindStore(bad, { log: () => {}, retries: 3, backoffMs: 1, alert: (m) => alerts.push(m), onReserveFailed: (id, why) => failedCalls.push([id, why]) });
  await wb2.reserve({ rfqId: 'B' }, {}).pending;
  assert.strictEqual(n, 3); assert.deepStrictEqual(failedCalls, [['B', 'db_error']]); assert.strictEqual(alerts.length, 1);
  assert.deepStrictEqual(await wb2.confirmCheck('B', 1, {}), { ok: false, reason: 'reserve_failed' });
  assert.strictEqual(await wb2.release('B', 'cancelled', {}), true);

  // cap reason from DB is not retried
  let m = 0; const wb3 = createWriteBehindStore({ reserve: async () => { m += 1; return { ok: false, reason: 'total_cap' }; } }, { log: () => {} });
  await wb3.reserve({ rfqId: 'C' }, {}).pending; assert.strictEqual(m, 1); assert.strictEqual(wb3.reserveFailed('C'), 'total_cap');

  // long cap in memory
  const now = Date.now(); const L = { positions: new Map([['x', { risk: 4900, long: true }], ['y', { risk: 3000, long: false }]]) };
  assert.strictEqual(memoryCapReason(L, 'new', { risk: 200, settleAt: now + 72 * 3600e3, nowMs: now, longCap: 5000, shortHours: 48 }), 'long_cap');
  assert.strictEqual(memoryCapReason(L, 'new', { risk: 200, settleAt: now + 10 * 3600e3, nowMs: now, longCap: 5000, shortHours: 48 }), null);
  assert.strictEqual(memoryCapReason(L, 'new', { risk: 50, settleAt: null, nowMs: now, longCap: 5000, shortHours: 48 }), null);
  assert.strictEqual(isLongPos(NaN, now, 48), true);
  console.log('write-behind ok');
})().catch((e) => { console.error(e); process.exit(1); });
