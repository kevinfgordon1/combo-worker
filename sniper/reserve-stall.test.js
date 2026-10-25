'use strict';
// Oct 25 2026 reserve stall: pullStarted no-overlap + bounded concurrency, batched releases,
// reserve timeout, skip-decision filter.
const test = require('node:test'); const assert = require('node:assert');
const { createLiveSniper } = require('./live');
const { createReleaseBatcher, withReserveTimeout, mapLimit, isSkipDecision } = require('./release-batch');
const S = require('../auto-sniper');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function rig({ cancelMs = 30, pullConcurrency, pullGuard } = {}) {
  const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' });
  const st = { v: null }; let inFlight = 0; let peak = 0; let n = 0; const cancels = [];
  const trader = { live: true,
    postQuote: async () => ({ quoteId: `Q${++n}`, noBid: '0.419', yesBid: '0.00' }),
    cancel: async (qid) => { inFlight += 1; peak = Math.max(peak, inFlight); cancels.push(qid); await wait(cancelMs); inFlight -= 1; return { statusCode: 204 }; } };
  const store = { release: async () => true, update: async () => true };
  const L = createLiveSniper({ config, trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.5, log: () => {}, ttlMs: 60000, startedReason: () => st.v, pullConcurrency, pullGuard });
  return { L, cancels, peak: () => peak, start: () => { st.v = 'game_started'; } };
}
async function fill(L, k) { for (let i = 0; i < k; i += 1) await L.send({ rfqId: `R${i}`, marketTicker: 'KXMVE-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes'], contracts: 20, createdTs: Date.now() }, { rfqId: `R${i}`, quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8.38 }); }

test('pullStarted: overlapping sweep is skipped, cancels run 4 wide', async () => {
  const h = rig(); await fill(h.L, 10); assert.strictEqual(h.L.pending.size, 10); h.start();
  const a = h.L.pullStarted(); const b = await h.L.pullStarted();
  assert.strictEqual(b, 0); assert.strictEqual(h.L.stats().pullSkipped, 1);
  assert.strictEqual(await a, 10); assert.strictEqual(h.cancels.length, 10); assert.strictEqual(h.peak(), 4);
  assert.strictEqual(h.L.pending.size, 0);
});
test('pullStarted: SNIPER_PULL_CONCURRENCY=1 + guard off = old sequential behaviour', async () => {
  const h = rig({ pullConcurrency: 1, pullGuard: false }); await fill(h.L, 3); h.start();
  await Promise.all([h.L.pullStarted(), h.L.pullStarted()]);
  assert.strictEqual(h.peak(), 2); assert.strictEqual(h.L.stats().pullSkipped, 0); // two sweeps overlap, each 1 wide (old)
});

function fakeSupabase({ fail = false } = {}) {
  const updates = [];
  return { updates, from: () => ({ update: (patch) => ({ in: async (col, ids) => { updates.push({ patch, ids }); return fail ? { error: { message: 'x' } } : { error: null }; } }) }) };
}
test('release batcher: one UPDATE per phase per flush', async () => {
  const sb = fakeSupabase(); const b = createReleaseBatcher({ supabase: sb, flushMs: 20, log: () => {} });
  const ps = ['a', 'b', 'c'].map((id) => b.release(id, 'cancelled')).concat([b.release('d', 'declined')]);
  assert.deepStrictEqual(await Promise.all(ps), [true, true, true, true]);
  assert.strictEqual(sb.updates.length, 2);
  assert.deepStrictEqual(sb.updates.find((u) => u.patch.phase === 'cancelled').ids, ['a', 'b', 'c']);
  assert.strictEqual(sb.updates[0].patch.status, 'released');
  assert.ok(b.canBatch('cancelled', {})); assert.ok(!b.canBatch('settled', {})); assert.ok(!b.canBatch('failed', { x: 1 }));
});
test('release batcher: failed batch falls back to per-row release', async () => {
  const sb = fakeSupabase({ fail: true }); const fb = [];
  const b = createReleaseBatcher({ supabase: sb, flushMs: 5, log: () => {}, fallback: async (id) => { fb.push(id); return true; } });
  await Promise.all([b.release('a', 'cancelled'), b.release('b', 'cancelled')]);
  assert.deepStrictEqual(fb, ['a', 'b']);
});
test('reserve timeout: slow reserve -> timeout fast, late ok row released', async () => {
  let late = 0; const t0 = Date.now();
  const r = await withReserveTimeout(wait(80).then(() => ({ ok: true })), 20, () => { late += 1; });
  assert.deepStrictEqual(r, { ok: false, reason: 'timeout' }); assert.ok(Date.now() - t0 < 70);
  await wait(100); assert.strictEqual(late, 1);
  assert.deepStrictEqual(await withReserveTimeout(Promise.resolve({ ok: true }), 20), { ok: true });
  const p = Promise.resolve({ ok: true }); assert.strictEqual(withReserveTimeout(p, 0), p);
});
test('mapLimit + isSkipDecision', async () => {
  assert.deepStrictEqual(await mapLimit([1, 2, 3], 2, async (x) => x * 2), [2, 4, 6]);
  assert.ok(isSkipDecision({ action: 'aborted' })); assert.ok(isSkipDecision({ action: 'rogue_line' }));
  for (const a of ['quoted', 'summary', 'would_quote', 'book_arb', 'fill']) assert.ok(!isSkipDecision({ action: a }));
});
