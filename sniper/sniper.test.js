'use strict';
const assert = require('assert');
const { createLimiter, createRateBreaker } = require('./limiter');
const { createLedgerStore } = require('./ledger-store');
const { decide, pregameCheck } = require('./engine');
const { bestCost, ALL_VENUES } = require('./fair');
const S = require('../auto-sniper');
const { capsFrom } = require('./ledger-store');

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

  // ledger store: reserve goes through the atomic DB function; DB errors fail closed
  const rpcCalls = [];
  let rpcAnswer = 'ok';
  const sb = { rpc: async (fn, args) => { rpcCalls.push([fn, args]); return rpcAnswer === 'ERR' ? { error: { message: 'boom' } } : { data: rpcAnswer, error: null }; },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [{ rfq_id: 'r1', combo_key: 'A|B', games: ['g1'], legs: ['A'], risk: 40, release_at: new Date(Date.now() + 1e8).toISOString(), created_at: new Date().toISOString(), phase: 'quoted' }], error: null }) }) }) }) }) };
  const store = createLedgerStore({ supabase: sb, log: () => {} });
  const d = { rfqId: 'r1', combo: 'A|B', games: ['g1', 'g2'], legs: ['A', 'B'], risk: 40, ev: 1.2, roi: 0.03, quoteYes: 0.6, quoteAmerican: -150, fairYes: 0.58, fairAmerican: -138, contracts: 100, fee: 0, makerRate: 0 };
  const caps = capsFrom(S.sniperConfig({ SNIPER_ENABLED: '1' }), '2026-10-21T04:00:00.000Z', true);
  assert.deepStrictEqual(await store.reserve(d, { releaseAt: Date.now() + 1e8, dryRun: false, caps }), { ok: true });
  assert.strictEqual(rpcCalls[0][0], 'sniper_reserve'); assert.strictEqual(rpcCalls[0][1].p_caps.total, 10000); assert.strictEqual(rpcCalls[0][1].p_caps.live, true);
  rpcAnswer = 'duplicate'; assert.strictEqual((await store.reserve(d, { releaseAt: 1, dryRun: false, caps })).reason, 'duplicate');
  rpcAnswer = 'total_cap'; assert.strictEqual((await store.reserve(d, { releaseAt: 1, dryRun: false, caps })).reason, 'total_cap');
  rpcAnswer = 'ERR'; assert.strictEqual((await store.reserve(d, { releaseAt: 1, dryRun: false, caps })).reason, 'db_error');
  assert.strictEqual((await store.confirmCheck('r1', 40, caps)).reason, 'db_error');
  rpcAnswer = 'ok';
  const led = S.createSniperLedger();
  assert.strictEqual((await store.hydrate(led, '2000-01-01T00:00:00Z', { live: true })).length, 1);
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
  // player-TD combo: 7% min edge (SNIPER_MIN_ROI_TD), stored on decision for send/confirm reprice
  assert.strictEqual(out.decision.minRoi, 0.07); assert.strictEqual(out.decision.hasTd, true);
  assert.ok(out.decision.roi >= 0.07 - 1e-9, String(out.decision.roi));
  const hi = decide(rfq, { config: S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_MIN_ROI_TD: '1000' }), ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => Date.parse('2026-10-25T17:00:00Z'), makerRate: 0, nowMs: Date.parse('2026-10-21T05:00:00Z') });
  assert.strictEqual(hi.decision.reason, 'roi_below_min_td', JSON.stringify(hi.decision));
  const off = decide(rfq, { config: S.sniperConfig({}), ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => 1e15, nowMs: 0 });
  assert.strictEqual(off.decision.reason, 'kill_switch');
  const stale = decide(rfq, { config, ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => 1e15, nowMs: 0, pricesHealthy: false });
  assert.strictEqual(stale.decision.reason, 'prices_stale');
  const same = decide({ ...rfq, rfqId: 'q2', legKeys: ['KXNFLGAME-26OCT25INDMIN-MIN:yes', 'KXNFLTD-26OCT25INDMIN-MINJJEFFERSON18-1:yes'] }, { config, ledger: S.createSniperLedger(), pmLive, tdBook, venues: ALL_VENUES, kickoffFor: () => 1e15, nowMs: 0 });
  assert.ok(/scope_correlated/.test(same.decision.reason), same.decision.reason);
  console.log('sniper/sniper.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
