'use strict';
const assert = require('assert');
const { createLimiter, createRateBreaker } = require('./limiter');
const { createLedgerStore } = require('./ledger-store');
const { decide, pregameCheck } = require('./engine');
const { bestCost, ALL_VENUES } = require('./fair');
const S = require('../auto-sniper');

(async () => {
  // limiter: rate, 429 backoff, breaker trips once
  let t = 0; const slept = [];
  const L = createLimiter({ name: 'k', ratePerSec: 2, burst: 1, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await L.run(async () => ({ ok: true, status: 200 }));
  await L.run(async () => ({ ok: true, status: 200 }));
  assert.ok(slept[0] >= 499, 'second call waits for a token');
  await assert.rejects(L.run(async () => ({ ok: false, status: 429 })), /429/);
  assert.strictEqual(L.stats().r429, 1); assert.ok(L.stats().backoffMs >= 2000);
  let trips = 0; const B = createRateBreaker({ max: 3, onTrip: () => trips++, now: () => 0 });
  B.hit('k'); B.hit('k'); assert.ok(!B.tripped()); B.hit('k'); B.hit('k');
  assert.ok(B.tripped()); assert.strictEqual(trips, 1);

  // ledger store: idempotent insert, duplicate → blocked, hydrate rebuilds ledger
  const rows = new Map();
  const sb = { from: () => ({
    insert: async (r) => { if (rows.has(r.rfq_id) || [...rows.values()].some((x) => x.combo_key === r.combo_key && x.status === 'open')) return { error: { code: '23505', message: 'duplicate' } }; rows.set(r.rfq_id, { ...r, created_at: new Date().toISOString() }); return { error: null }; },
    update: () => ({ eq: () => ({ eq: () => ({ lt: async () => ({}) }) }) }),
    select: () => ({ eq: () => ({ gt: () => ({ limit: async () => ({ data: [...rows.values()], error: null }) }) }) }),
  }) };
  const store = createLedgerStore({ supabase: sb, log: () => {} });
  const d = { rfqId: 'r1', combo: 'A|B', games: ['g1', 'g2'], legs: ['A', 'B'], risk: 40, ev: 1.2, roi: 0.03, quoteYes: 0.6, quoteAmerican: -150, fairYes: 0.58, fairAmerican: -138, contracts: 100, fee: 0, makerRate: 0 };
  assert.deepStrictEqual(await store.reserve(d, { releaseAt: Date.now() + 1e8, dryRun: true }), { ok: true });
  assert.strictEqual((await store.reserve(d, { releaseAt: Date.now() + 1e8, dryRun: true })).reason, 'duplicate');
  assert.strictEqual((await store.reserve({ ...d, rfqId: 'r2' }, { releaseAt: Date.now() + 1e8, dryRun: true })).reason, 'duplicate');
  const led = S.createSniperLedger();
  assert.strictEqual(await store.hydrate(led, '2000-01-01T00:00:00Z'), 1);
  assert.strictEqual(led.totals().total, 40); assert.ok(led.seenRfqs.has('r1'));

  // fair: best of four, top-only ignored
  const src = (venue, cost, reason = 'ok') => ({ venue, cost, reason, used: true });
  assert.strictEqual(bestCost([src('kalshi', 0.6), src('polymarket', 0.5, 'top_only'), src('novig', 0.58)], ALL_VENUES).venue, 'novig');

  // pregame
  assert.strictEqual(pregameCheck(['X:yes'], () => null, 0, 0), 'no_kickoff');
  assert.strictEqual(pregameCheck(['X:yes'], () => 1000, 990, 30), 'game_started');
  assert.strictEqual(pregameCheck(['X:yes'], () => 1e9, 0, 30), null);

  // decide: end-to-end with stub books
  const pmLive = { legFair: () => ({ sources: [src('kalshi', 0.6), src('novig', 0.58)] }) };
  const tdBook = { legMulti: () => ({ sources: [src('kalshi', 0.7)] }), kickoffMs: () => null };
  const config = S.sniperConfig({ SNIPER_ENABLED: '1' });
  const rfq = { rfqId: 'q1', marketTicker: 'KXMVECROSSCATEGORY0-X', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:yes'], contracts: 20 };
  const out = decide(rfq, { config, ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => Date.parse('2026-10-25T17:00:00Z'), makerRate: 0, nowMs: Date.parse('2026-10-21T05:00:00Z') });
  assert.strictEqual(out.decision.action, 'quote', JSON.stringify(out.decision));
  assert.ok(Math.abs(out.decision.fairYes - 0.42 * 0.30) < 1e-9);
  assert.ok(out.decision.releaseAt > Date.parse('2026-10-25T00:00:00Z'));
  const off = decide(rfq, { config: S.sniperConfig({}), ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => 1e15, nowMs: 0 });
  assert.strictEqual(off.decision.reason, 'kill_switch');
  const stale = decide(rfq, { config, ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => 1e15, nowMs: 0, pricesHealthy: false });
  assert.strictEqual(stale.decision.reason, 'prices_stale');
  const same = decide({ ...rfq, rfqId: 'q2', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLTD-26OCT25INDMIN-MINJJEFFERSON18-1:yes'] }, { config, ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => 1e15, nowMs: 0 });
  assert.ok(/scope_correlated/.test(same.decision.reason), same.decision.reason);
  // no order path: the runner module never references a quote POST
  const src2 = require('fs').readFileSync(require.resolve('./runner'), 'utf8');
  assert.ok(!/communications\/quotes|method:\s*'POST'/.test(src2), 'sniper runner must not contain an order path');
  console.log('sniper/sniper.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
