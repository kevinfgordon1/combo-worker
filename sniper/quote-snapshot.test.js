'use strict';
// Oct 28 2026: the quote-status check now reads a COMPLETE snapshot of our OPEN quotes (Kalshi does not
// list un-accepted cancelled quotes, so the old status=cancelled poll saw ~4/run and saved 0 DELETEs).
// A quote missing from the snapshot skips its ROUTINE DELETE; everything uncertain still cancels.
const test = require('node:test'); const assert = require('node:assert');
const S = require('../auto-sniper');
const { createLiveSniper } = require('./live');
const { createSniperTrader } = require('./trader');
const { createLimiter } = require('./limiter');
const TEST_PEM = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

const config = { ...S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' }), minRoi: 0.05 };
const rfq = (id) => ({ rfqId: id, marketTicker: 'KXMVE-X', legKeys: [], contracts: 100, createdTs: Date.now() });
const dd = (id) => ({ rfqId: id, quoteYes: 0.4, contracts: 100, makerRate: 0, risk: 60, ev: 2, legs: ['a', 'b'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function rig({ ttlMs = 60000, cancelGate = null } = {}) {
  const calls = []; const t = { v: 100000 };
  const trader = { live: true,
    postQuote: async (r) => ({ quoteId: `Q${r.rfqId}`, noBid: '0.600', yesBid: '0.00' }),
    cancel: async (qid, o) => {
      if (cancelGate) await cancelGate;
      if (o && o.skipIf && o.skipIf()) { calls.push(`skip:${qid}`); return { skipped: true }; }
      calls.push(`cancel:${o && o.urgent ? 'urgent' : 'routine'}:${qid}`); return { statusCode: 204 };
    },
    confirm: async (r, q) => { calls.push(`confirm:${q}`); } };
  const store = { release: async () => true, update: async () => true, confirmCheck: async () => ({ ok: true }) };
  const L = createLiveSniper({ config, trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.3, log: () => {}, ttlMs, now: () => t.v, defer: () => {} });
  return { L, calls, t };
}
const snap = (t, ids, o = {}) => ({ ids: new Set(ids), complete: true, startedAt: t.v, newestCreatedLocalMs: t.v - 100, ...o });

test('missing from a complete open snapshot -> routine TTL DELETE skipped', async () => {
  const { L, calls, t } = rig({ ttlMs: 30 });
  await L.send(rfq('A'), dd('A')); await L.send(rfq('B'), dd('B'));
  t.v += 3000;
  assert.strictEqual(L.onOpenSnapshot(snap(t, ['QB'])), 1);
  await wait(60);
  assert.ok(!calls.includes('cancel:routine:QA')); assert.ok(calls.includes('cancel:routine:QB'), 'listed open => DELETE');
  const st = L.stats(); assert.strictEqual(st.cancelAvoided.not_open_snapshot, 1); assert.strictEqual(st.markedNotOpen, 1);
});

test('fail safe: partial snapshot, too-young quote, listing not caught up, accepted -> no inference', async () => {
  const { L, t } = rig();
  await L.send(rfq('A'), dd('A'));
  assert.strictEqual(L.onOpenSnapshot(snap(t, [], { complete: false })), 0, 'partial');
  t.v += 1000; assert.strictEqual(L.onOpenSnapshot(snap(t, [])), 0, 'posted < grace before the read');
  t.v += 5000;
  assert.strictEqual(L.onOpenSnapshot(snap(t, [], { newestCreatedLocalMs: 50000 })), 0, 'listing has nothing newer than our quote');
  assert.strictEqual(L.onOpenSnapshot(snap(t, [], { newestCreatedLocalMs: null })), 0, 'empty listing proves nothing');
  L.pending.get('QA').accepted = true;
  assert.strictEqual(L.onOpenSnapshot(snap(t, [])), 0, 'accepted');
  assert.strictEqual(L.isGone('QA'), false);
  assert.strictEqual(L.onOpenSnapshot(null), 0);
});

test('a not-open mark never releases the quote early: a late WS accept still confirms', async () => {
  const { L, calls, t } = rig();
  await L.send(rfq('A'), dd('A')); t.v += 3000;
  L.onOpenSnapshot(snap(t, []));
  assert.strictEqual(L.pending.size, 1);
  const r = await L.onAccepted({ quoteId: 'QA', rfqId: 'A', acceptedSide: 'no', contractsAccepted: 100 });
  assert.strictEqual(r.confirmed, true); assert.ok(calls.includes('confirm:QA'));
});

test('queued routine DELETE is skipped when a snapshot shows the quote gone', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const { L, calls, t } = rig({ ttlMs: 20, cancelGate: gate });
  await L.send(rfq('C'), dd('C')); await wait(40); // TTL fired, DELETE waiting for a token
  assert.strictEqual(L.queuedCancelCount(), 1);
  t.v += 3000; assert.strictEqual(L.onOpenSnapshot(snap(t, [])), 1);
  open(); await wait(10);
  assert.deepStrictEqual(calls, ['skip:QC']);
  assert.strictEqual(L.stats().cancelAvoided.not_open_while_queued, 1); assert.strictEqual(L.queuedCancelCount(), 0);
});

test('backstop: a skipped quote that shows up open later gets its DELETE (never left resting)', async () => {
  const { L, calls, t } = rig({ ttlMs: 20 });
  await L.send(rfq('D'), dd('D')); t.v += 3000;
  L.onOpenSnapshot(snap(t, [])); await wait(40);
  assert.ok(!calls.some((c) => c.endsWith(':QD')), 'skipped');
  t.v += 1000; L.onOpenSnapshot(snap(t, ['QD'])); await wait(5);
  assert.ok(calls.includes('cancel:routine:QD'), calls.join(','));
  assert.strictEqual(L.stats().notOpenReappeared, 1);
});

test('urgent cancels ignore the snapshot', async () => {
  const { L, calls, t } = rig();
  await L.send(rfq('E'), dd('E')); t.v += 3000; L.onOpenSnapshot(snap(t, []));
  await L.shutdown();
  assert.deepStrictEqual(calls, ['cancel:urgent:QE']);
});

test('trader.openQuotesSnapshot: READ lane GETs, status=open + subaccount, pages to the end, complete flag', async () => {
  const seen = []; const W = createLimiter({ name: 'w', ratePerSec: 100, burst: 5 }); const R = createLimiter({ name: 'r', ratePerSec: 100, burst: 5 });
  const pages = [
    { quotes: [{ id: 'q1', status: 'open', created_ts: '2026-10-28T16:00:00Z' }], cursor: 'c2' },
    { quotes: [{ id: 'q2', status: 'open', created_ts: '2026-10-28T16:00:05Z' }, { id: 'qx', status: 'cancelled' }], cursor: '' },
  ];
  const tr = createSniperTrader({ gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, limiter: W, readLimiter: R, log: () => {},
    request: async ({ method, path }) => { seen.push([method, path]); return { statusCode: 200, headers: {}, text: JSON.stringify(pages[seen.length - 1]) }; } });
  const s = await tr.openQuotesSnapshot();
  assert.deepStrictEqual([...s.ids], ['q1', 'q2']); assert.strictEqual(s.complete, true);
  assert.strictEqual(s.newestCreatedMs, Date.parse('2026-10-28T16:00:05Z'));
  assert.ok(seen.every(([m]) => m === 'GET'));
  assert.match(seen[0][1], /status=open/); assert.match(seen[0][1], /subaccount=1/); assert.match(seen[0][1], /user_filter=self/); assert.match(seen[1][1], /cursor=c2/);
  assert.strictEqual(W.stats().requests, 0, 'no write-lane tokens'); assert.strictEqual(R.stats().requests, 2);
  // more pages than allowed -> incomplete
  const tr2 = createSniperTrader({ gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, limiter: W, readLimiter: R, log: () => {},
    request: async () => ({ statusCode: 200, headers: {}, text: JSON.stringify({ quotes: [{ id: 'z', status: 'open' }], cursor: 'more' }) }) });
  assert.strictEqual((await tr2.openQuotesSnapshot({ maxPages: 2 })).complete, false);
  // read error -> throws (caller infers nothing)
  const tr3 = createSniperTrader({ gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, limiter: W, readLimiter: R, log: () => {},
    request: async () => ({ statusCode: 500, headers: {}, text: '' }) });
  await assert.rejects(() => tr3.openQuotesSnapshot());
});
