'use strict';
// Oct 28 2026 fix 2: waiting (resting, unaccepted) quotes count at a fraction toward caps, committed
// exposure still counts in full on its own, and a new RFQ may replace our waiting quote on the same
// parlay instead of skipping already_hold_combo. Batched ledger releases land before inserts.
const test = require('node:test'); const assert = require('node:assert');
const S = require('../auto-sniper');
const { createLiveSniper } = require('./live');
const { createBatchedLedgerStore } = require('./ledger-batch');

const legs = (a, b) => [
  { ticker: `KXNFLGAME-26NOV01${a}-${a.slice(0, 3)}`, side: 'yes', fair_yes: 0.6 },
  { ticker: `KXNFLGAME-26NOV01${b}-${b.slice(0, 3)}`, side: 'yes', fair_yes: 0.6 },
];
const row = (id, l, contracts = 100) => ({ rfq_id: id, venue: 'kalshi', status: 'seen', legs: l, contracts });
const cfg = (o = {}) => ({ ...S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' }), minRoi: 0.05, ...o });

test('committed exposure counts in full even when resting weight is low', () => {
  const L = S.createSniperLedger({ dayRiskOnAdd: false }); L.restingWeight = 0.25;
  const l = legs('INDJAC', 'BUFMIA'); const leg0 = S.legKey(l[0]);
  L.positions.set('f', { combo: 'other', games: ['g'], legs: [leg0], risk: 700, releaseAt: Infinity }); // committed
  const d = S.evaluateSnipe(row('r1', l), { config: cfg({ perLegCap: 750 }), ledger: L, nowMs: Date.now(), makerRate: 0 });
  assert.strictEqual(d.action, 'skip'); assert.strictEqual(d.reason, 'leg_cap');
  // the same 700 resting counts 175 -> fits
  L.positions.get('f').resting = true;
  const d2 = S.evaluateSnipe(row('r2', l), { config: cfg({ perLegCap: 750 }), ledger: L, nowMs: Date.now(), makerRate: 0 });
  assert.strictEqual(d2.action, 'quote');
});

test('same parlay: committed blocks, waiting quote is replaced only when canReplace agrees', () => {
  const l = legs('INDJAC', 'BUFMIA'); const combo = S.comboKey(l);
  const mk = (resting, canReplace) => { const L = S.createSniperLedger({ dayRiskOnAdd: false }); L.restingWeight = 0.25;
    L.positions.set('old', { combo, games: [], legs: [], risk: 40, releaseAt: Infinity, resting }); if (canReplace) L.canReplace = canReplace; return L; };
  let L = mk(false, () => true);
  assert.strictEqual(S.evaluateSnipe(row('n1', l), { config: cfg(), ledger: L, makerRate: 0 }).reason, 'already_hold_combo');
  L = mk(true, null);
  assert.strictEqual(S.evaluateSnipe(row('n2', l), { config: cfg(), ledger: L, makerRate: 0 }).reason, 'already_hold_combo');
  L = mk(true, () => false);
  assert.strictEqual(S.evaluateSnipe(row('n3', l), { config: cfg(), ledger: L, makerRate: 0 }).reason, 'already_hold_combo');
  L = mk(true, () => true);
  assert.strictEqual(S.evaluateSnipe(row('n4', l), { config: cfg({ replaceResting: false }), ledger: L, makerRate: 0 }).reason, 'already_hold_combo');
  let seen = null; L = mk(true, (ids, o) => { seen = { ids, o }; return true; });
  const d = S.evaluateSnipe(row('n5', l), { config: cfg(), ledger: L, makerRate: 0 });
  assert.strictEqual(d.action, 'quote'); assert.deepStrictEqual(d.replaces, ['old']);
  assert.deepStrictEqual(seen.ids, ['old']); assert.ok(Number.isFinite(seen.o.ev));
});

test('replaced quote is left out of the cap totals', () => {
  const l = legs('INDJAC', 'BUFMIA'); const combo = S.comboKey(l); const leg0 = S.legKey(l[0]);
  const L = S.createSniperLedger({ dayRiskOnAdd: false }); L.restingWeight = 1; L.canReplace = () => true;
  L.positions.set('old', { combo, games: [], legs: [leg0], risk: 740, releaseAt: Infinity, resting: true });
  const d = S.evaluateSnipe(row('n', l), { config: cfg({ perLegCap: 750 }), ledger: L, makerRate: 0 });
  assert.strictEqual(d.action, 'quote'); assert.deepStrictEqual(d.replaces, ['old']);
});

function rig({ ttlMs = 60000, t = { v: 1000 } } = {}) {
  const calls = []; const ops = [];
  const trader = { live: true,
    postQuote: async (rfq) => { calls.push(`post:${rfq.rfqId}`); return { quoteId: `Q${rfq.rfqId}`, noBid: '0.600', yesBid: '0.00' }; },
    cancel: async (qid, o) => { if (o && o.skipIf && o.skipIf()) { calls.push(`skip:${qid}`); return { skipped: true }; } calls.push(`cancel:${o && o.urgent ? 'urgent' : 'routine'}:${qid}`); return { statusCode: 204 }; },
    confirm: async (r, q) => { calls.push(`confirm:${q}`); } };
  const store = { release: async (id, ph) => ops.push(['release', id, ph]), update: async () => true, confirmCheck: async () => ({ ok: true }) };
  const late = [];
  const L = createLiveSniper({ config: cfg(), trader, store, coord: { blockReason: () => null, comboWorkerQuoting: async () => null }, caps: () => ({}), reprice: () => 0.3, log: () => {}, ttlMs, now: () => t.v, onLateAccept: (r) => late.push(r), defer: (fn) => fn() });
  return { L, calls, ops, t, late };
}
const rfq = (id) => ({ rfqId: id, marketTicker: 'KXMVE-X', legKeys: [], contracts: 100, createdTs: Date.now() });
const dd = (id, ev = 2) => ({ rfqId: id, quoteYes: 0.4, contracts: 100, makerRate: 0, risk: 60, ev, legs: ['a', 'b'] });

test('canSupersede: age or better EV; never accepted / unknown quotes; supersede = routine cancel + release', async () => {
  const { L, calls, ops, t, late } = rig();
  await L.send(rfq('A'), dd('A', 2));
  assert.strictEqual(L.canSupersede('A', { ev: 1, minAgeMs: 3000 }), false, 'young + worse EV');
  assert.strictEqual(L.canSupersede('A', { ev: 3, minAgeMs: 3000 }), true, 'young but better EV');
  t.v += 3000;
  assert.strictEqual(L.canSupersede('A', { ev: 0.1, minAgeMs: 3000 }), true, 'old enough');
  assert.strictEqual(L.canSupersede('nope', { ev: 9 }), false);
  assert.strictEqual(L.supersede('A'), true);
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.includes('cancel:routine:QA'), calls.join(','));
  assert.deepStrictEqual(ops.find((o) => o[1] === 'A'), ['release', 'A', 'cancelled']);
  assert.strictEqual(L.stats().superseded, 1);
  // accepted later: not confirmed, logged as superseded
  const r = await L.onAccepted({ quoteId: 'QA', rfqId: 'A', acceptedSide: 'no' });
  assert.strictEqual(r.reason, 'not_ours'); assert.ok(!calls.includes('confirm:QA'));
  assert.strictEqual(late[0].cls, 'superseded'); assert.strictEqual(L.stats().lateAccepts.superseded, 1);
  // an accepted quote can never be superseded
  await L.send(rfq('B'), dd('B'));
  await L.onAccepted({ quoteId: 'QB', rfqId: 'B', acceptedSide: 'no' });
  t.v += 10000;
  assert.strictEqual(L.canSupersede('B', { ev: 99, minAgeMs: 0 }), false);
});

test('batched ledger flush: releases are written before inserts (same combo replace)', async () => {
  const seq = [];
  const supabase = { from: () => ({
    upsert: async (rows) => { seq.push(`insert:${rows.map((r) => r.rfq_id).join(',')}`); return { error: null }; },
    update: (patch) => ({ in: async (_c, ids) => { seq.push(`update:${patch.status}:${ids.join(',')}`); return { error: null }; } }),
  }) };
  const B = createBatchedLedgerStore({}, { supabase, flushMs: 5, log: () => {} });
  // old row already in the DB (earlier flush)
  B.reserve({ rfqId: 'old', combo: 'c', games: [], legs: [], risk: 1 }, { releaseAt: Date.now() + 1000 }); await B.flush(); seq.length = 0;
  const rel = B.release('old', 'cancelled');
  B.reserve({ rfqId: 'new', combo: 'c', games: [], legs: [], risk: 1 }, { releaseAt: Date.now() + 1000 });
  await B.flush(); await rel;
  assert.deepStrictEqual(seq, ['update:released:old', 'insert:new']);
});
