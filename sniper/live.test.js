'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { liveGate, LIVE_CONFIRM_TOKEN } = require('./gates');
const { createSniperTrader, noBidFor } = require('./trader');
const { createLiveSniper } = require('./live');
const { createLockCoord } = require('./coord');
const S = require('../auto-sniper');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ALL = { SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0', SNIPER_LIVE_CONFIRM: LIVE_CONFIRM_TOKEN, SNIPER_KALSHI_KEY_ID: 'k', SNIPER_KALSHI_PRIVATE_KEY: PEM, SNIPER_KALSHI_SUBACCOUNT: '7' };

(async () => {
  // ── gates: live only when every gate is set ──
  assert.strictEqual(liveGate(ALL).live, true);
  for (const [k, bad] of [['SNIPER_ENABLED', '0'], ['SNIPER_ENABLED', undefined], ['SNIPER_DRY_RUN', undefined], ['SNIPER_DRY_RUN', '1'], ['SNIPER_DRY_RUN', 'false'],
    ['SNIPER_LIVE_CONFIRM', undefined], ['SNIPER_LIVE_CONFIRM', 'yes'], ['SNIPER_KALSHI_KEY_ID', undefined], ['SNIPER_KALSHI_PRIVATE_KEY', ''], ['SNIPER_KALSHI_SUBACCOUNT', undefined], ['SNIPER_KALSHI_SUBACCOUNT', '0'], ['SNIPER_KALSHI_SUBACCOUNT', '64']]) {
    const env = { ...ALL, [k]: bad }; if (bad === undefined) delete env[k];
    assert.strictEqual(liveGate(env).live, false, `${k}=${bad} must keep dry run`);
  }
  assert.strictEqual(liveGate({}).live, false);

  // ── live send impossible unless all gates set: trader refuses and never touches the network ──
  for (const env of [{}, { ...ALL, SNIPER_DRY_RUN: '1' }, { ...ALL, SNIPER_LIVE_CONFIRM: '' }, { ...ALL, SNIPER_ENABLED: '0' }]) {
    let calls = 0;
    const t = createSniperTrader({ gate: liveGate(env), keyId: 'k', pem: PEM, request: async () => { calls += 1; return { statusCode: 201, text: '{"id":"q"}' }; }, log: () => {} });
    await assert.rejects(t.postQuote({ rfqId: 'r', contracts: 10, createdTs: Date.now() }, 0.6, 0.001), /LIVE_GATE_CLOSED/);
    await assert.rejects(t.confirm('r', 'q'), /LIVE_GATE_CLOSED/);
    await assert.rejects(t.cancel('q'), /LIVE_GATE_CLOSED/);
    assert.strictEqual(calls, 0); assert.strictEqual(t.stats().refused, 3);
  }

  // ── live trader: same Kalshi calls as combo-worker ──
  const sent = [];
  const t = createSniperTrader({ gate: liveGate(ALL), keyId: 'k', pem: PEM, subaccount: 7, log: () => {}, request: async (req) => {
    sent.push(req);
    if (req.method === 'POST') return { statusCode: 201, headers: {}, text: '{"id":"Q1"}' };
    if (req.method === 'PUT') return { statusCode: 200, headers: {}, text: '{}' };
    if (req.method === 'DELETE') return { statusCode: 404, headers: {}, text: '' };
    return { statusCode: 200, headers: {}, text: JSON.stringify({ fills: [{ fill_id: 'f1', order_id: 'O1', ticker: 'KXMVE-X', count_fp: '20', no_price_dollars: '0.42', fee_cost: '0.05' }] }) };
  } });
  const q = await t.postQuote({ rfqId: 'R1', contracts: 20, createdTs: Date.now() }, 0.581, 0.001);
  assert.strictEqual(q.quoteId, 'Q1'); assert.strictEqual(q.noBid, '0.419'); assert.strictEqual(q.yesBid, '0.00');
  assert.strictEqual(sent[0].path, '/trade-api/v2/communications/quotes');
  assert.deepStrictEqual(JSON.parse(sent[0].body), { rfq_id: 'R1', yes_bid: '0.00', no_bid: '0.419', rest_remainder: false, subaccount: 7 });
  assert.ok(sent[0].headers['KALSHI-ACCESS-SIGNATURE'] || sent[0].headers['kalshi-access-signature']);
  await t.confirm('R1', 'Q1');
  assert.strictEqual(sent[1].method, 'PUT'); assert.strictEqual(sent[1].path, '/trade-api/v2/communications/rfqs/R1/quotes/Q1/confirm'); assert.strictEqual(sent[1].body, '{}');
  assert.strictEqual((await t.cancel('Q1')).statusCode, 404);
  const fb = await t.fillsForOrder('O1'); assert.strictEqual(fb.reason, 'confirmed'); assert.strictEqual(fb.contracts, 20);
  assert.ok(/subaccount=7/.test(sent[3].path), 'fills read scoped to the sniper subaccount');
  // a trader without a subaccount refuses to quote even with the gate open
  const t0 = createSniperTrader({ gate: { live: true }, keyId: 'k', pem: PEM, request: async () => { throw new Error('network'); }, log: () => {} });
  await assert.rejects(t0.postQuote({ rfqId: 'r', contracts: 1, createdTs: Date.now() }, 0.6, 0.001), /quote_no_subaccount/);
  assert.strictEqual(noBidFor(0.6, 0.01), '0.40'); assert.strictEqual(noBidFor(0.5815, 0.001), '0.418');

  // ── coordination: Combo Locks priority, fail closed ──
  let clock = 1e6;
  const coord = createLockCoord({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [{ quote_id: 'cw' }], error: null }) }) }) }) }) }, now: () => clock, log: () => {} });
  const rfq = { rfqId: 'R1', marketTicker: 'KXMVECROSSCATEGORY0-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLGAME-26OCT25CINBAL-BAL:yes'], contracts: 20, createdTs: Date.now() };
  assert.strictEqual(coord.blockReason(rfq), 'locks_unknown');
  coord.setLocks([{ id: 'L', leg_keys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLGAME-26OCT25CINBAL-BAL:yes'] }]);
  assert.strictEqual(coord.blockReason(rfq), 'combo_lock_match');
  coord.setLocks([{ id: 'L', leg_keys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLGAME-26OCT25NYGPHI-NYG:yes'] }]);
  assert.strictEqual(coord.blockReason(rfq), 'overlaps_combo_lock');
  coord.setLocks([]); assert.strictEqual(coord.blockReason(rfq), null);
  clock += 31000; assert.strictEqual(coord.blockReason(rfq), 'locks_unknown');
  assert.strictEqual(await coord.comboWorkerQuoting('R1'), 'combo_worker_quoting');

  // ── live lifecycle with fakes ──
  const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_DRY_RUN: '0' });
  function rig({ fair = 0.5, capReason = null, block = null, live = true, holds = null } = {}) {
    const calls = []; const alerts = []; const ledgerOps = [];
    const trader = { live, postQuote: async () => { calls.push('post'); return { quoteId: 'Q1', noBid: '0.419', yesBid: '0.00' }; },
      confirm: async () => { calls.push('confirm'); }, cancel: async () => { calls.push('cancel'); },
      fillsForOrder: async () => ({ reason: 'confirmed', contracts: 20, book: [{ fill_id: 'f1', count: 20, no_price: 0.419, fee: 0, ticker: 'KXMVE-X' }] }) };
    const store = { release: async (id, phase, x) => { ledgerOps.push(['release', id, phase, x]); }, update: async (id, p) => { ledgerOps.push(['update', id, p]); },
      confirmCheck: async () => (capReason ? { ok: false, reason: capReason } : { ok: true }),
      openFilled: async () => [{ rfq_id: 'R1', market_ticker: 'KXMVE-X', filled_contracts: 20, filled_cost: 8.38, filled_fee: 0 }],
      dayRealized: async () => -1600 };
    const c = { blockReason: () => block, comboWorkerQuoting: async () => null };
    const ref = { fair };
    const L = createLiveSniper({ config, trader, store, coord: c, caps: () => ({}), reprice: () => ref.fair, alert: (m) => alerts.push(m), log: () => {}, ttlMs: 50, fillRetryMs: 1, sleep: async () => {}, onHold: async (dd) => { if (holds) holds.push(dd.rfqId); } });
    return { L, calls, alerts, ledgerOps, ref };
  }
  const d = { rfqId: 'R1', quoteYes: 0.581, contracts: 20, makerRate: 0, risk: 8.38 };
  // accept extends the short quote hold (onHold) only after the DB cap check passes
  { const holds = []; const h = rig({ fair: 0.5, holds });
    await h.L.send(rfq, d); assert.deepStrictEqual(holds, []);
    await h.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'no', contractsAccepted: 20 });
    assert.deepStrictEqual(holds, ['R1']);
    const h2 = rig({ fair: 0.5, holds: [], capReason: 'total_cap' }); await h2.L.send(rfq, d);
    await h2.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'no' }); }
  // graceful shutdown cancels open unaccepted quotes on Kalshi and releases their rows, then refuses sends
  { const g = rig({ fair: 0.5 }); await g.L.send(rfq, d);
    assert.strictEqual(await g.L.shutdown(), 1);
    assert.deepStrictEqual(g.calls, ['post', 'cancel']);
    assert.ok(g.ledgerOps.some((o) => o[0] === 'release' && o[1] === 'R1' && o[2] === 'cancelled'));
    assert.strictEqual(g.L.pending.size, 0);
    assert.strictEqual((await g.L.send(rfq, d)).sent, false); }
  // happy path: send → accept → confirm → fill → settle (loss) → daily stop
  let r = rig({ fair: 0.5 });
  assert.deepStrictEqual(await r.L.send(rfq, d), { sent: true, quoteId: 'Q1' });
  assert.strictEqual((await r.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'no', contractsAccepted: 20 })).confirmed, true);
  assert.deepStrictEqual(r.calls, ['post', 'confirm']);
  assert.strictEqual(r.alerts.length, 0, 'no separate ACCEPTED message');
  assert.strictEqual((await r.L.onExecuted({ quoteId: 'Q1', orderId: 'O1' })).booked, true);
  assert.strictEqual(r.alerts.length, 1, 'one message per fill'); assert.ok(/^🎯 SNIPER FILL/.test(r.alerts[0]));
  assert.ok(r.ledgerOps.some((o) => o[0] === 'update' && o[2].order_id === 'O1' && !o[2].phase), 'order id recorded before fills lookup');
  const up = r.ledgerOps.find((o) => o[0] === 'update' && o[2].phase === 'filled'); assert.strictEqual(up[2].filled_contracts, 20);
  const original = createLiveSniper; void original;
  await r.L.settleOnce(async () => 'yes', '2026-10-21T04:00:00Z');
  const st = r.ledgerOps.find((o) => o[0] === 'release' && o[2] === 'settled'); assert.ok(Math.abs(st[3].realized_pnl + 8.38) < 1e-9);
  assert.ok(r.L.halted()); assert.ok(r.alerts.some((m) => /AUTO-DISABLED/.test(m)));
  assert.strictEqual((await r.L.send({ ...rfq, rfqId: 'R2' }, { ...d, rfqId: 'R2' })).reason, 'halted');
  // re-price at send below 3% → abort, no POST
  r = rig({ fair: 0.57 }); assert.strictEqual((await r.L.send(rfq, d)).reason, 'reprice_below_min'); assert.deepStrictEqual(r.calls, []);
  // lock appears → abort
  r = rig({ block: 'combo_lock_match' }); assert.strictEqual((await r.L.send(rfq, d)).reason, 'combo_lock_match'); assert.deepStrictEqual(r.calls, []);
  // confirm-time price moved → decline (cancel, never confirm)
  r = rig({ fair: 0.5 }); await r.L.send(rfq, d); r.ref.fair = 0.575;
  assert.strictEqual((await r.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'no' })).reason, 'reprice_below_min');
  assert.deepStrictEqual(r.calls, ['post', 'cancel']);
  // cap-at-confirm fails → decline
  r = rig({ capReason: 'total_cap' }); await r.L.send(rfq, d);
  assert.strictEqual((await r.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'no' })).reason, 'cap_total_cap');
  assert.ok(!r.calls.includes('confirm'));
  // payout over cap at accept → decline
  r = rig(); await r.L.send(rfq, d);
  assert.strictEqual((await r.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'no', contractsAccepted: 150 })).reason, 'payout_over_cap');
  // YES-side accept → decline
  r = rig(); await r.L.send(rfq, d);
  r.L.pending.get('Q1').yesBid = '0.58';
  assert.strictEqual((await r.L.onAccepted({ quoteId: 'Q1', rfqId: 'R1', acceptedSide: 'yes' })).reason, 'yes_side_accept');
  // not our quote → ignored
  assert.strictEqual((await r.L.onAccepted({ quoteId: 'OTHER' })).reason, 'not_ours');
  // unaccepted TTL → cancel + release
  r = rig(); await r.L.send(rfq, d); await new Promise((res) => setTimeout(res, 80));
  assert.ok(r.calls.includes('cancel')); assert.ok(r.ledgerOps.some((o) => o[0] === 'release' && o[2] === 'cancelled'));
  // gate closed trader → never posts
  r = rig({ live: false }); assert.strictEqual((await r.L.send(rfq, d)).reason, 'not_live'); assert.deepStrictEqual(r.calls, []);
  console.log('sniper/live.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });

{ // postFailKey classifies Kalshi errors and stale drops
  const { postFailKey } = require('./live');
  assert.strictEqual(postFailKey(new Error('Kalshi quote failed 409: {"error":{"code":"rfq_closed","message":"rfq closed"}}')), 'http_409:rfq_closed');
  assert.strictEqual(postFailKey(new Error('STALE_DROP rfq_age age=3100ms')), 'stale_drop:rfq_age');
  assert.strictEqual(postFailKey(new Error('boom')), 'error');
}
