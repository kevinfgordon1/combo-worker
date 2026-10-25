'use strict';
const assert = require('node:assert/strict');
const { createBatchedLedgerStore, ledgerBatchEnabled } = require('./ledger-batch');

function fakeSb(failFirst = false) {
  const ops = []; let fail = failFirst;
  return { ops, from() { return {
    upsert(rows) { ops.push({ op: 'upsert', n: rows.length, rows }); const e = fail ? { message: 'timeout' } : null; return Promise.resolve({ error: e }); },
    update(patch) { return { in(k, ids) { ops.push({ op: 'update', patch, ids }); return Promise.resolve({ error: null }); } }; },
  }; }, heal() { fail = false; } };
}
const d = (id) => ({ rfqId: id, risk: 10, side: 'yes', legs: [], fair: 0.5, price: 0.45, contracts: 10 });

(async () => {
  assert.equal(ledgerBatchEnabled({}), true); assert.equal(ledgerBatchEnabled({ SNIPER_LEDGER_BATCH: '0' }), false);
  const sb = fakeSb();
  const s = createBatchedLedgerStore({ confirmCheck: async () => ({ ok: true }) }, { supabase: sb, flushMs: 10000, log: () => {} });
  for (let i = 0; i < 50; i++) assert.equal(s.reserve(d('r' + i), { releaseAt: 1e12 }).ok, true);
  const p = s.update('r1', { quote_id: 'q1' });
  await s.flush(); assert.equal(await p, true);
  assert.equal(sb.ops.length, 1, '50 reserves + update = one upsert'); assert.equal(sb.ops[0].n, 50);
  const ps = ['r2', 'r3', 'r4'].map((id) => s.release(id, 'expired'));
  await s.flush(); await Promise.all(ps);
  assert.equal(sb.ops.length, 2, 'identical releases = one UPDATE ... IN'); assert.deepEqual(sb.ops[1].ids, ['r2', 'r3', 'r4']);
  // full queue fails closed
  const s2 = createBatchedLedgerStore({}, { supabase: fakeSb(), flushMs: 10000, maxQueue: 3, log: () => {} });
  for (let i = 0; i < 3; i++) s2.reserve(d('x' + i), { releaseAt: 1e12 });
  assert.deepEqual(s2.reserve(d('x9'), { releaseAt: 1e12 }), { ok: false, reason: 'batch_full' });
  // DB failure requeues, then lands
  const sb3 = fakeSb(true);
  const s3 = createBatchedLedgerStore({}, { supabase: sb3, flushMs: 10000, log: () => {} });
  s3.reserve(d('y1'), { releaseAt: 1e12 });
  assert.equal(await s3.flush(), false); assert.equal(s3.backlog(), 1);
  sb3.heal(); assert.equal(await s3.flush(), true); assert.equal(s3.backlog(), 0);
  // open breaker: no DB call at all
  const sb4 = fakeSb();
  const s4 = createBatchedLedgerStore({}, { supabase: sb4, flushMs: 10000, log: () => {}, breaker: { isOpen: () => true } });
  s4.reserve(d('z'), { releaseAt: 1e12 }); await s4.flush(); assert.equal(sb4.ops.length, 0);
  console.log('ledger-batch ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
