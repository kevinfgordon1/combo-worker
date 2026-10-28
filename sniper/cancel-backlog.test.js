'use strict';
// Oct 28 2026 cancel-backlog fixes: (1) reserved cancel tokens + oldest-first routine DELETEs,
// (2) drop lowest-EV posts while cancels are backed up, (3) 409 quote_timed_out burst breaker with
// sampled logging, (4) startup cancel of the previous process's open quotes (sniper subaccount only).
const test = require('node:test'); const assert = require('node:assert');
const S = require('../auto-sniper');
const { createLimiter } = require('./limiter');
const { createPostGate, createQtoBreaker } = require('./cancel-backlog');
const { selectStartupCancels, startupCancelOpen } = require('./startup-cancel');
const { createLiveSniper } = require('./live');
const { createSniperTrader, requestIdOf } = require('./trader');
const TEST_PEM = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fix 1: limiter ──
async function flood(lim, ms, { lowWaiters = 0 } = {}) {
  let stop = false; const n = { post: 0, low: 0 };
  const post = async () => { while (!stop) await lim.run(async () => { n.post += 1; return { ok: true }; }); };
  const low = async () => { while (!stop) await lim.run(async () => { n.low += 1; return { ok: true }; }, { priority: 0 }); };
  const ps = [post(), post(), post(), post()]; const ls = []; for (let i = 0; i < lowWaiters; i += 1) ls.push(low());
  const t0 = Date.now(); await wait(ms); stop = true; await Promise.all([...ps, ...ls]);
  const sec = (Date.now() - t0) / 1000;
  return { post: n.post / sec, low: n.low / sec };
}
test('fix 1: reserved cancel lane gets ~N/s under a quote flood; quotes get ~rate-N', async () => {
  const lim = createLimiter({ name: 'r', ratePerSec: 20, burst: 2, lowShareRps: 5, reserveLow: true });
  const r = await flood(lim, 3000, { lowWaiters: 4 });
  assert.ok(r.low >= 4.0 && r.low <= 7.0, `cancels ${r.low}/s`);
  assert.ok(r.post >= 12 && r.post <= 17.5, `posts ${r.post}/s`);
  assert.ok(r.post + r.low <= 22, `total ${r.post + r.low}/s within budget`);
  assert.strictEqual(lim.lowShareRps(), 5); assert.strictEqual(lim.stats().mainRps, 15);
});
test('fix 1: idle reserve can be borrowed by quotes only when no cancel waits', async () => {
  const lim = createLimiter({ name: 'b', ratePerSec: 20, burst: 2, lowShareRps: 5, reserveLow: true });
  const r = await flood(lim, 1500);
  assert.ok(r.post >= 17, `posts borrow idle reserve: ${r.post}/s`); assert.ok(lim.stats().borrowedLow > 0);
});
test('fix 1: urgent cancels still go first and may use the reserve', async () => {
  const lim = createLimiter({ name: 'u', ratePerSec: 20, burst: 1, lowShareRps: 5, reserveLow: true });
  let stop = false; const p = (async () => { while (!stop) await lim.run(async () => ({ ok: true })); })();
  const t0 = Date.now(); for (let i = 0; i < 10; i += 1) await lim.run(async () => ({ ok: true }), { priority: 2 });
  const ms = Date.now() - t0; stop = true; await p;
  assert.ok(ms < 900, `10 urgent in ${ms}ms`);
});
test('fix 1 off switch: reserveLow=false keeps the old shared-bucket share', async () => {
  const lim = createLimiter({ name: 'o', ratePerSec: 20, burst: 2, lowShareRps: 5 });
  assert.strictEqual(lim.reserveLow(), false); assert.strictEqual(lim.stats().mainRps, 20);
});
test('fix 1: 429 step-down keeps the reserve and halves at most', () => {
  const lim = createLimiter({ name: 's', ratePerSec: 20, ratePerSecOn429: 10, burst: 2, lowShareRps: 5, reserveLow: true });
  lim.on429(); assert.strictEqual(lim.lowShareRps(), 5); assert.strictEqual(lim.stats().mainRps, 5);
  const lim2 = createLimiter({ name: 's2', ratePerSec: 6, burst: 2, lowShareRps: 5, reserveLow: true });
  assert.strictEqual(lim2.lowShareRps(), 3, 'reserve never above half the budget');
});

// ── Fix 2: post gate ──
test('fix 2: gate levels drop the lowest-EV posts, never above the cut', () => {
  const g = createPostGate({ maxQueued: 50, maxAgeMs: 15000 });
  for (let i = 1; i <= 100; i += 1) g.note(i / 10); // EVs 0.1..10
  const calm = { queued: 10, oldestAgeMs: 13000 };
  assert.strictEqual(g.check(0.01, calm, { record: false }), null, 'no backlog => every post goes');
  assert.strictEqual(g.level({ queued: 51 }), 1); assert.strictEqual(g.level({ queued: 0, oldestAgeMs: 15001 }), 1);
  assert.strictEqual(g.level({ queued: 101 }), 2); assert.strictEqual(g.level({ oldestAgeMs: 22600 }), 2);
  assert.strictEqual(g.level({ queued: 201 }), 3); assert.strictEqual(g.level({ oldestAgeMs: 30001 }), 3);
  const l1 = { queued: 60 };
  assert.strictEqual(g.check(2, l1, { record: false }), 'cancel_backlog_l1'); assert.strictEqual(g.check(8, l1, { record: false }), null);
  const l2 = { queued: 120 };
  assert.strictEqual(g.check(8, l2, { record: false }), 'cancel_backlog_l2'); assert.strictEqual(g.check(9.5, l2, { record: false }), null);
  assert.strictEqual(g.check(1e6, { queued: 500 }, { record: false }), 'cancel_backlog_l3', 'level 3 pauses posts until cancels catch up');
  const st = g.stats(); assert.strictEqual(st.dropped, 3); assert.deepStrictEqual(st.droppedByLevel, { 1: 1, 2: 1, 3: 1 });
});
test('fix 2 off switch: enabled=false never drops', () => {
  const g = createPostGate({ enabled: false }); assert.strictEqual(g.check(0, { queued: 1e6, oldestAgeMs: 1e9 }), null);
});

// ── Fix 3: breaker ──
test('fix 3: >50% quote_timed_out in the window trips a pause, escalates, resumes half-open', () => {
  let t = 0; const trips = []; const b = createQtoBreaker({ windowMs: 10000, ratio: 0.5, minSamples: 20, pauseMs: 10000, maxPauseMs: 30000, now: () => t, onTrip: (o) => trips.push(o.pauseMs) });
  for (let i = 0; i < 19; i += 1) { b.record(true); t += 10; } assert.strictEqual(b.paused(), false, 'below minSamples');
  t += 10001; // window slides past them
  for (let i = 0; i < 40; i += 1) { b.record(i % 2 === 1); t += 10; } assert.strictEqual(b.paused(), false, "at most 50% never trips");
  for (let i = 0; i < 5; i += 1) b.record(true);
  assert.strictEqual(b.paused(), true); assert.deepStrictEqual(trips, [10000]);
  for (let i = 0; i < 50; i += 1) b.record(true); assert.strictEqual(b.stats().trips, 1, 'outcomes during a pause never re-trip');
  t += 10001; assert.strictEqual(b.paused(), false, 'resumes');
  for (let i = 0; i < 20; i += 1) b.record(true); assert.strictEqual(b.paused(), true); assert.deepStrictEqual(trips, [10000, 20000]);
  t += 20001; b.paused(); for (let i = 0; i < 20; i += 1) b.record(true); t += 30001; b.paused(); for (let i = 0; i < 20; i += 1) b.record(true);
  assert.deepStrictEqual(trips, [10000, 20000, 30000, 30000], 'capped at maxPauseMs');
  t += 30001 + 30000; b.paused(); for (let i = 0; i < 20; i += 1) b.record(true); assert.strictEqual(trips[trips.length - 1], 10000, 'clean gap resets escalation');
});
test('fix 3 off switch', () => { const b = createQtoBreaker({ enabled: false }); for (let i = 0; i < 100; i += 1) b.record(true); assert.strictEqual(b.paused(), false); });

// ── live.js integration ──
const config = { ...S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' }), minRoi: 0.05 };
const rfq = (id) => ({ rfqId: id, marketTicker: 'KXMVE-X', legKeys: [], contracts: 100, createdTs: Date.now(), recvAt: Date.now(), recvAge: 50 });
const dd = (id, ev = 2) => ({ rfqId: id, quoteYes: 0.4, contracts: 100, makerRate: 0, risk: 60, ev, legs: ['a', 'b'] });
function rig({ ttlMs = 60000, cancelMs = 0, post = null, ...o } = {}) {
  const calls = []; const logs = []; let active = 0; let peak = 0;
  const trader = { live: true,
    postQuote: post || (async (r) => { calls.push(`post:${r.rfqId}`); return { quoteId: `Q${r.rfqId}`, noBid: '0.600', yesBid: '0.00' }; }),
    cancel: async (qid, c) => {
      active += 1; peak = Math.max(peak, active);
      if (cancelMs) await wait(cancelMs);
      active -= 1;
      if (c && c.skipIf && c.skipIf()) { calls.push(`skip:${qid}`); return { skipped: true }; }
      calls.push(`cancel:${c && c.urgent ? 'urgent' : 'routine'}:${qid}`); return { statusCode: 204 };
    },
    confirm: async () => {} };
  const store = { release: async () => true, update: async () => true, confirmCheck: async () => ({ ok: true }) };
  const L = createLiveSniper({ config, trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.3, log: (m) => logs.push(m), ttlMs, defer: () => {}, ...o });
  return { L, calls, logs, peak: () => peak };
}
test('fix 1b: FIFO routine DELETEs go out oldest-first, bounded concurrency, closed ones skipped free', async () => {
  const h = rig({ ttlMs: 5, cancelMs: 15, cancelFifo: true, cancelConcurrency: 2 });
  for (const id of ['A', 'B', 'C', 'D', 'E']) { await h.L.send(rfq(id), dd(id)); await wait(2); }
  await h.L.onRfqClosed({ rfqId: 'D' });
  await wait(150);
  const routine = h.calls.filter((c) => c.startsWith('cancel:routine'));
  assert.deepStrictEqual(routine, ['cancel:routine:QA', 'cancel:routine:QB', 'cancel:routine:QC', 'cancel:routine:QE'].filter((x) => routine.includes(x)));
  assert.ok(h.peak() <= 2, `peak ${h.peak()}`);
  assert.strictEqual(h.L.queuedCancelCount(), 0);
});
test('fix 2 in live: backlog state counts only DELETEs that will be sent; gate drops low-EV posts before the POST', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const g = createPostGate({ maxQueued: 2, maxAgeMs: 60000 });
  for (let i = 1; i <= 100; i += 1) g.note(i * 10); // median 500, far above any test quote EV
  const calls = [];
  const trader = { live: true, postQuote: async (r) => { calls.push(`post:${r.rfqId}`); return { quoteId: `Q${r.rfqId}`, noBid: '0.600', yesBid: '0.00' }; },
    cancel: async (qid) => { await gate; calls.push(`cancel:${qid}`); return { statusCode: 204 }; }, confirm: async () => {} };
  const L = createLiveSniper({ config, trader, store: { release: async () => true, update: async () => true }, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.3, log: () => {}, ttlMs: 5, defer: () => {}, cancelFifo: true, cancelConcurrency: 1, postGate: g });
  for (const id of ['A', 'B', 'C', 'D']) await L.send(rfq(id), dd(id, 50));
  await wait(30);
  assert.strictEqual(L.backlogState().queued, 4);
  await L.onRfqClosed({ rfqId: 'D' }); await wait(250);
  assert.strictEqual(L.backlogState().queued, 3, 'closed RFQ is not backlog');
  assert.strictEqual(L.postBlockReason(0.2), 'cancel_backlog_l1'); assert.strictEqual(L.postBlockReason(900), null, 'high-EV post still goes');
  const low = await L.send(rfq('LOW'), dd('LOW', 0.2)); // reprice EV is what the gate sees
  assert.strictEqual(low.sent, false); assert.ok(!calls.includes('post:LOW'), 'dropped before the POST');
  open(); await wait(50);
  assert.ok(calls.includes('cancel:QA') && calls.includes('cancel:QB') && calls.includes('cancel:QC'), 'cancels are never dropped');
  assert.strictEqual(L.postBlockReason(0.2), null, 'drained => posts again');
});
test('fix 3 in live: breaker pauses posts after a 409 burst; sampled QTO log has age / request id / body', async () => {
  let t = 1000; const b = createQtoBreaker({ minSamples: 5, now: () => t });
  const qto = async () => { const e = new Error('Kalshi quote failed 409: {"error":{"code":"quote_timed_out","message":"quote timed out"}}'); e.statusCode = 409; e.requestId = 'x-request-id=abc'; e.body = '{"error":{"code":"quote_timed_out"}}'; e.wireMs = 700; throw e; };
  const h = rig({ post: qto, qtoBreaker: b, qtoSampleFirst: 2, qtoSampleEvery: 3 });
  for (let i = 0; i < 5; i += 1) { const r = await h.L.send(rfq(`R${i}`), dd(`R${i}`)); assert.strictEqual(r.sent, false); }
  assert.strictEqual(b.paused(), true);
  assert.strictEqual(h.L.postBlockReason(5), 'qto_breaker');
  const r = await h.L.send(rfq('P'), dd('P')); assert.strictEqual(r.reason, 'qto_breaker');
  const samples = h.logs.filter((l) => l.includes('QTO_SAMPLE'));
  assert.strictEqual(samples.length, 3, 'first 2 + every 3rd'); assert.match(samples[0], /req_id=x-request-id=abc/); assert.match(samples[0], /rfq_age_end=\d+ms/); assert.match(samples[0], /wire_ms=700/); assert.match(samples[0], /quote_timed_out/);
  assert.ok(!h.logs.some((l) => l.includes('quote POST failed') && l.includes('quote_timed_out')), 'unsampled 409s are counted, not logged');
  assert.strictEqual(h.L.stats().postFailBy['http_409:quote_timed_out'], 5); assert.strictEqual(h.L.stats().qtoBreaker.trips, 1);
});

// ── trader ──
test('trader: request id from headers; POST error carries status/body/request id', async () => {
  assert.strictEqual(requestIdOf({ 'x-request-id': 'r1' }), 'x-request-id=r1'); assert.strictEqual(requestIdOf({ 'cf-ray': 'c1' }), 'cf-ray=c1'); assert.strictEqual(requestIdOf({}), null);
  const W = createLimiter({ name: 'w', ratePerSec: 100, burst: 5 });
  const tr = createSniperTrader({ gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, limiter: W, log: () => {},
    request: async () => ({ statusCode: 409, headers: { 'x-request-id': 'kal-1' }, text: '{"error":{"code":"quote_timed_out"}}' }) });
  const err = await tr.postQuote({ rfqId: 'R', createdTs: new Date().toISOString(), contracts: 10 }, 0.4, 0.001).catch((e) => e);
  assert.strictEqual(err.statusCode, 409); assert.strictEqual(err.requestId, 'x-request-id=kal-1'); assert.match(err.body, /quote_timed_out/);
});

// ── Fix 4 ──
test('fix 4: startup cancel selects only open, sniper-subaccount, pre-boot quotes', () => {
  const cutoff = Date.parse('2026-10-28T18:00:00Z');
  const qs = [
    { id: 'a', status: 'open', creator_subaccount: 1, created_ts: '2026-10-28T17:00:00Z' },
    { id: 'combo', status: 'open', creator_subaccount: 0, created_ts: '2026-10-28T17:00:00Z' },
    { id: 'nosub', status: 'open', created_ts: '2026-10-28T17:00:00Z' },
    { id: 'other', status: 'open', creator_subaccount: 2, created_ts: '2026-10-28T17:00:00Z' },
    { id: 'acc', status: 'accepted', creator_subaccount: 1, created_ts: '2026-10-28T17:00:00Z' },
    { id: 'new', status: 'open', creator_subaccount: 1, created_ts: '2026-10-28T18:00:01Z' },
    { id: 'nots', status: 'open', creator_subaccount: 1 },
  ];
  const s = selectStartupCancels(qs, { subaccount: 1, cutoffMs: cutoff });
  assert.deepStrictEqual(s.ids, ['a']);
  assert.deepStrictEqual(s.skipped, { other_subaccount: 3, not_open: 1, too_new: 1, no_created: 1 });
  assert.strictEqual(selectStartupCancels(qs, { subaccount: 0, cutoffMs: cutoff }).refused, 'no_subaccount', 'primary account (Combo Locks) refused');
});
test('fix 4: partial snapshot cancels nothing; complete snapshot cancels targets (404 = gone)', async () => {
  const cancels = [];
  const trader = { cancel: async (id) => { cancels.push(id); return { statusCode: id === 'b' ? 404 : 204 }; } };
  const quotes = [{ id: 'a', status: 'open', creator_subaccount: 1, created_ts: '2026-10-28T17:00:00Z' }, { id: 'b', status: 'open', creator_subaccount: 1, created_ts: '2026-10-28T17:00:00Z' }];
  const p = await startupCancelOpen({ trader, subaccount: 1, cutoffMs: Date.parse('2026-10-28T18:00:00Z'), snapshot: { complete: false, count: 2, quotes }, log: () => {}, sleep: async () => {} });
  assert.strictEqual(p.refused, 'partial_snapshot'); assert.deepStrictEqual(cancels, []);
  const r = await startupCancelOpen({ trader, subaccount: 1, cutoffMs: Date.parse('2026-10-28T18:00:00Z'), snapshot: { complete: true, count: 2, quotes }, log: () => {}, sleep: async () => {} });
  assert.deepStrictEqual(cancels, ['a', 'b']); assert.strictEqual(r.cancelled, 1); assert.strictEqual(r.gone, 1);
  const z = await startupCancelOpen({ trader, subaccount: null, cutoffMs: Date.now(), snapshot: { complete: true, count: 2, quotes }, log: () => {} });
  assert.strictEqual(z.refused, 'no_subaccount');
});
test('trader.openQuotesSnapshot returns light quote objects with creator_subaccount', async () => {
  const R = createLimiter({ name: 'r', ratePerSec: 100, burst: 5 }); const W = createLimiter({ name: 'w', ratePerSec: 100, burst: 5 });
  const tr = createSniperTrader({ gate: { live: true }, keyId: 'test-key', pem: TEST_PEM, subaccount: 1, limiter: W, readLimiter: R, log: () => {},
    request: async () => ({ statusCode: 200, headers: {}, text: JSON.stringify({ quotes: [{ id: 'q1', status: 'open', created_ts: '2026-10-28T16:00:00Z', creator_subaccount: 1, rfq_id: 'r1', yes_bid_dollars: '0.1' }], cursor: '' }) }) });
  const s = await tr.openQuotesSnapshot();
  assert.deepStrictEqual(s.quotes, [{ id: 'q1', status: 'open', created_ts: '2026-10-28T16:00:00Z', creator_subaccount: 1, rfq_id: 'r1' }]);
});

// ── Untracked-quote sweep ──
const { createUntrackedSweep } = require('./untracked-sweep');
test('untracked sweep: cancels only open, sniper-subaccount, untracked quotes older than 30s; once per resend window', async () => {
  let t = 1000000; const cancels = [];
  const trader = { cancel: async (id, o) => { cancels.push(`${id}:${o && o.urgent ? 'urgent' : 'routine'}`); return { statusCode: id === 'gone' ? 404 : 204 }; } };
  const tracked = new Set(['mine']);
  const sw = createUntrackedSweep({ trader, subaccount: 1, isTracked: (id) => tracked.has(id), now: () => t, log: () => {} });
  const server = Date.parse('2026-10-28T18:40:00Z');
  const old = '2026-10-28T18:39:00Z'; const young = '2026-10-28T18:39:45Z';
  const quotes = [
    { id: 'orphan', status: 'open', creator_subaccount: 1, created_ts: old },
    { id: 'gone', status: 'open', creator_subaccount: 1, created_ts: old },
    { id: 'mine', status: 'open', creator_subaccount: 1, created_ts: old },
    { id: 'young', status: 'open', creator_subaccount: 1, created_ts: young },
    { id: 'combo', status: 'open', creator_subaccount: 0, created_ts: old },
    { id: 'nosub', status: 'open', created_ts: old },
    { id: 'acc', status: 'accepted', creator_subaccount: 1, created_ts: old },
  ];
  assert.deepStrictEqual(sw.onSnapshot({ complete: true, quotes }, server), ['orphan', 'gone']);
  await wait(5);
  assert.deepStrictEqual(cancels, ['orphan:routine', 'gone:routine']);
  assert.strictEqual(sw.stats().sent, 1); assert.strictEqual(sw.stats().gone, 1); assert.strictEqual(sw.stats().skippedTracked, 1);
  assert.deepStrictEqual(sw.onSnapshot({ complete: true, quotes }, server), [], 'no repeat inside resend window');
  t += 30001; assert.deepStrictEqual(sw.onSnapshot({ complete: true, quotes }, server), ['orphan', 'gone'], 'retried if still listed open');
  assert.deepStrictEqual(sw.onSnapshot({ complete: false, quotes }, server + 60000), [], 'partial snapshot => nothing');
  assert.strictEqual(sw.stats().partial, 1);
});
test('untracked sweep: refuses without a sniper subaccount, off switch, maxPerTick, startup targets deduped', async () => {
  const cancels = []; const trader = { cancel: async (id) => { cancels.push(id); return { statusCode: 204 }; } };
  const q = (id) => ({ id, status: 'open', creator_subaccount: 0, created_ts: '2026-10-28T17:00:00Z' });
  const z = createUntrackedSweep({ trader, subaccount: 0, isTracked: () => false, log: () => {} });
  assert.deepStrictEqual(z.onSnapshot({ complete: true, quotes: [q('a')] }, Date.now()), []); assert.strictEqual(z.stats().refused, 'no_subaccount');
  const off = createUntrackedSweep({ enabled: false, trader, subaccount: 1, isTracked: () => false, log: () => {} });
  assert.deepStrictEqual(off.onSnapshot({ complete: true, quotes: [{ ...q('b'), creator_subaccount: 1 }] }, Date.now()), []);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, status: 'open', creator_subaccount: 1, created_ts: '2026-10-28T17:00:00Z' }));
  const sw = createUntrackedSweep({ trader, subaccount: 1, isTracked: () => false, maxPerTick: 10, log: () => {} });
  sw.mark(['m0', 'm1']);
  const first = sw.onSnapshot({ complete: true, quotes: many }, Date.now());
  assert.strictEqual(first.length, 10); assert.ok(!first.includes('m0') && !first.includes('m1'), 'startup cancel targets not re-sent');
  await wait(5); assert.strictEqual(cancels.length, 10);
});
test('live.isTrackedQuote: pending and queued routine DELETEs are tracked', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const trader = { live: true, postQuote: async (r) => ({ quoteId: `Q${r.rfqId}`, noBid: '0.600', yesBid: '0.00' }), cancel: async () => { await gate; return { statusCode: 204 }; }, confirm: async () => {} };
  const L = createLiveSniper({ config, trader, store: { release: async () => true, update: async () => true }, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.3, log: () => {}, ttlMs: 5, defer: () => {}, cancelFifo: true });
  await L.send(rfq('T'), dd('T')); assert.strictEqual(L.isTrackedQuote('QT'), true, 'pending');
  await wait(20); assert.strictEqual(L.pending.size, 0); assert.strictEqual(L.isTrackedQuote('QT'), true, 'queued DELETE');
  open(); await wait(10); assert.strictEqual(L.isTrackedQuote('QT'), false); assert.strictEqual(L.isTrackedQuote('nope'), false);
});
