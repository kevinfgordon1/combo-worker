'use strict';
// Oct 28 2026 fix 3 + accept-race fix: accepts for quotes we no longer track are classified, counted
// and logged OFF the WS handler (deferred), and a quote is ours before its ledger write lands.
const test = require('node:test'); const assert = require('node:assert');
const S = require('../auto-sniper');
const { createLiveSniper } = require('./live');

const config = { ...S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' }), minRoi: 0.05 };
const rfq = (id) => ({ rfqId: id, marketTicker: 'KXMVE-X', legKeys: [], contracts: 100, createdTs: Date.now() });
const dd = (id) => ({ rfqId: id, quoteYes: 0.4, contracts: 100, makerRate: 0, risk: 60, ev: 2, legs: ['a', 'b'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function rig({ earlyRegister = true, update = async () => true, post = null, ttlMs = 60000 } = {}) {
  const calls = []; const late = []; const deferred = []; const t = { v: 1000 };
  const trader = { live: true,
    postQuote: post || (async (r) => ({ quoteId: `Q${r.rfqId}`, noBid: '0.600', yesBid: '0.00' })),
    cancel: async (qid) => { calls.push(`cancel:${qid}`); return { statusCode: 204 }; },
    confirm: async (r, q) => { calls.push(`confirm:${q}`); } };
  const store = { release: async () => true, update, confirmCheck: async () => ({ ok: true }) };
  const L = createLiveSniper({ config, trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.3, log: (m) => calls.push(m), ttlMs, now: () => t.v, earlyRegister, onLateAccept: (r) => late.push(r), defer: (fn) => deferred.push(fn) });
  return { L, calls, late, deferred, t };
}

test('accept after our TTL expired -> after_ttl with quote age; logged only in deferred work', async () => {
  const r2 = rig({ ttlMs: 20 }); // short real TTL timer; the clock (now) is faked
  await r2.L.send(rfq('A'), dd('A'));
  r2.t.v += 12000; await wait(40);
  assert.strictEqual(r2.L.pending.size, 0, 'TTL dropped it');
  r2.t.v += 500;
  const res = await r2.L.onAccepted({ quoteId: 'QA', rfqId: 'A', acceptedSide: 'no' });
  assert.strictEqual(res.reason, 'not_ours');
  assert.strictEqual(r2.L.stats().lateAccepts.after_ttl, 1, 'counted synchronously');
  assert.strictEqual(r2.late.length, 0, 'nothing logged / written synchronously');
  r2.deferred.forEach((f) => f());
  assert.strictEqual(r2.late[0].cls, 'after_ttl'); assert.strictEqual(r2.late[0].ageMs, 12500); assert.strictEqual(r2.late[0].side, 'no');
  assert.ok(r2.calls.some((m) => /LATE_ACCEPT cls=after_ttl side=no/.test(m)));
  assert.ok(!r2.calls.includes('confirm:QA'));
});

test('never-seen quote -> unknown; RFQ closed on WS -> after_rfq_closed_ws', async () => {
  const { L, deferred, late } = rig();
  await L.onAccepted({ quoteId: 'X', rfqId: 'other', acceptedSide: 'yes' });
  await L.send(rfq('B'), dd('B'));
  await L.onRfqClosed({ rfqId: 'B' });
  await L.onAccepted({ quoteId: 'QB', rfqId: 'B', acceptedSide: 'no' });
  deferred.forEach((f) => f());
  assert.deepStrictEqual(late.map((r) => r.cls), ['unknown', 'after_rfq_closed_ws']);
  assert.deepStrictEqual(L.stats().lateAcceptsBySide, { yes: 1, no: 1 });
});

test('accept race: accept while the ledger write is pending is confirmed (early register)', async () => {
  let releaseUpdate; const gate = new Promise((r) => { releaseUpdate = r; });
  const { L, calls } = rig({ update: () => gate });
  const sending = L.send(rfq('C'), dd('C'));
  await wait(5); // POST returned, ledger 'quoted' write still pending
  const r = await L.onAccepted({ quoteId: 'QC', rfqId: 'C', acceptedSide: 'no', contractsAccepted: 100 });
  assert.strictEqual(r.confirmed, true, JSON.stringify(r)); assert.ok(calls.includes('confirm:QC'));
  releaseUpdate(true); await sending;
});

test('accept race, old order (SNIPER_EARLY_REGISTER=0): same accept is lost and classified during_post', async () => {
  let releaseUpdate; const gate = new Promise((r) => { releaseUpdate = r; });
  const { L, calls, deferred, late } = rig({ earlyRegister: false, update: () => gate });
  const sending = L.send(rfq('D'), dd('D'));
  await wait(5);
  const r = await L.onAccepted({ quoteId: 'QD', rfqId: 'D', acceptedSide: 'no' });
  assert.strictEqual(r.reason, 'not_ours'); assert.ok(!calls.includes('confirm:QD'));
  deferred.forEach((f) => f()); assert.strictEqual(late[0].cls, 'during_post');
  releaseUpdate(true); await sending;
});

test('accept before the POST even returned is buffered and replayed (confirmed)', async () => {
  let finishPost; const postGate = new Promise((r) => { finishPost = r; });
  const { L, calls, deferred, late } = rig({ post: async (r) => { await postGate; return { quoteId: `Q${r.rfqId}`, noBid: '0.600', yesBid: '0.00' }; } });
  const sending = L.send(rfq('E'), dd('E'));
  await wait(5);
  const r = await L.onAccepted({ quoteId: 'QE', rfqId: 'E', acceptedSide: 'no', contractsAccepted: 100 });
  assert.strictEqual(r.reason, 'buffered');
  finishPost(); await sending; await wait(5);
  assert.ok(calls.includes('confirm:QE'), calls.join('|'));
  assert.strictEqual(L.stats().earlyAcceptReplayed, 1);
  deferred.forEach((f) => f()); assert.strictEqual(late[0].cls, 'during_post_buffered');
});

test('yes-side accept on a dollar quote is still declined (unchanged)', async () => {
  const { L, calls } = rig({ post: async (r) => ({ quoteId: `Q${r.rfqId}`, noBid: '0.600', yesBid: '0.400' }) });
  await L.send(rfq('F'), dd('F'));
  const r = await L.onAccepted({ quoteId: 'QF', rfqId: 'F', acceptedSide: 'yes' });
  assert.strictEqual(r.reason, 'yes_side_accept'); assert.ok(calls.includes('cancel:QF'));
});
