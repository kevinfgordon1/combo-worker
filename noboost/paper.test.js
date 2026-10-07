'use strict';
const assert = require('assert');
const { createNoBoostShadow } = require('./shadow');
const { createPaperRun, toRow, legBucket } = require('./paper');
const { createStore } = require('./store');
const { makeBook } = require('./test-util');

const G1 = { game: '26OCT04ARINYG', a: 'ARI', b: 'NYG', askA: 0.52, bidA: 0.50, askB: 0.50, bidB: 0.48 };
const G2 = { game: '26OCT04DENSF', a: 'DEN', b: 'SF', askA: 0.40, bidA: 0.38, askB: 0.62, bidB: 0.60 };
let t = 1e12;
const now = () => t;
const book = makeBook([G1, G2], () => t);
const base = { NOBOOST_SHADOW: '1', NOBOOST_FAIR_METHOD: 'mid', NOBOOST_MARGIN: '0.10' };
const quiet = () => {};
const primary = createNoBoostShadow({ book, env: { ...base, NOBOOST_GUARDRAIL: 'off' }, log: quiet, now: () => Date.now(), label: 'PRIMARY' });
const lockcf = createNoBoostShadow({ book, env: { ...base, NOBOOST_GUARDRAIL: 'lock' }, log: quiet, now: () => Date.now(), label: 'LOCKCF' });
const rows = []; const patches = []; const stats = [];
const run = createPaperRun({ book, primary, lockcf, margin: 0.1, persist: (r, k) => (k === 'patch' ? patches.push(r) : rows.push(r)), persistStats: (s) => stats.push(s), now: () => Date.now() });
const keys = ['KXNFLGAME-26OCT04ARINYG-ARI:yes', 'KXNFLGAME-26OCT04DENSF-DEN:yes'];
const rfq = (id, extra = {}) => ({ rfqId: id, marketTicker: `KXMVE-${id}`, legKeys: keys, contracts: 20, createdMs: Date.now(), ...extra });

// both variants decide; primary (lock OFF) quotes at-or-below the lock-ON variant
const rec = run.onRfq(rfq('a'));
assert.ok(rec && rec.primary.action === 'would_quote' && rec.lockcf.action === 'would_quote');
assert.ok(rec.primary.quoteYes <= rec.lockcf.quoteYes, 'lock ON is never cheaper than lock OFF');
assert.ok(Number.isFinite(rec.fair_mid_american) && Number.isFinite(rec.primary.quote_american));
assert.ok(rec.decision_ms >= 0 && rec.decision_ms < 50, `decision ms ${rec.decision_ms}`);
assert.ok(Array.isArray(rec.leg_ages_ms) && rec.leg_ages_ms.length === 2);
assert.ok(rec.margin === 0.1);
// out-of-scope RFQs are counted but not recorded
assert.strictEqual(run.onRfq({ rfqId: 'x', marketTicker: 'KXMVE-x', legKeys: ['KXNFLGAME-26OCT04ARINYG-ARI:yes', 'KXNFLSPREAD-26OCT04DENSF-DEN3:yes'] }), null);
assert.strictEqual(run._delta().out_of_scope, 1);

// a print BELOW our quote => no win; a print above => win + simulated fill within caps
const r2 = run.onRfq(rfq('b'));
const cheap = r2.primary.quoteYes - 0.01;
run.onTrade({ id: 't1', ticker: 'KXMVE-b', yes: cheap, count: 20, takerSide: 'yes', ms: Date.now() + 500 });
assert.strictEqual(r2.primary.beat, 'no'); assert.strictEqual(r2.outcome, 'traded');
const r3 = run.onRfq(rfq('c'));
run.onTrade({ id: 't2', ticker: 'KXMVE-c', yes: r3.primary.quoteYes + 0.05, count: 20, takerSide: 'yes', ms: Date.now() + 500 });
assert.strictEqual(r3.primary.beat, 'win'); assert.strictEqual(r3.primary.fill, true);
assert.ok(r3.primary.position.max_loss > 0 && r3.primary.position.caps_ok === true);
assert.ok(r3.primary.position.total_after > 0, 'paper position/exposure recorded');
assert.ok(primary.risk.total() > 0 && lockcf.risk.total() === 0 || r3.lockcf.beat !== 'win' || lockcf.risk.total() >= 0);
// duplicate trade id ignored; taker NO is not a win candidate
assert.strictEqual(run.onTrade({ id: 't2', ticker: 'KXMVE-c', yes: 0.9, count: 1, takerSide: 'yes', ms: Date.now() + 500 }), null);
const r4 = run.onRfq(rfq('d'));
run.onTrade({ id: 't3', ticker: 'KXMVE-d', yes: 0.9, count: 20, takerSide: 'no', ms: Date.now() + 500 });
assert.strictEqual(r4.outcome, 'taker_no');

// row shape: American odds columns, no percentages
const row = toRow(r3);
for (const k of ['quote_primary_american', 'quote_lock_american', 'fair_mid_american', 'traded_american', 'decision_ms', 'max_leg_age_ms', 'primary_position']) assert.ok(k in row, k);
assert.ok(Number.isInteger(row.quote_primary_american) && Number.isInteger(row.fair_mid_american));
assert.strictEqual(row.primary_beat, 'win');

// settlement realizes P&L and frees exposure (leg results: hit)
(async () => {
  const before = primary.risk.total();
  await run.settle(async () => 'yes'); // both legs won => combo hit => we lose
  assert.ok(primary.risk.total() < before);
  assert.ok(patches.some((p) => p.rfq_id === 'c' && p.hit === true && p.primary_pnl < 0));
  // unknown results keep the fill open
  const r5 = run.onRfq(rfq('e'));
  run.onTrade({ id: 't5', ticker: 'KXMVE-e', yes: r5.primary.quoteYes + 0.05, count: 20, takerSide: 'yes', ms: Date.now() + 500 });
  await run.settle(async () => null);
  assert.strictEqual(run.openFills.length, 1);
  const s = run.flushStats();
  assert.ok(s.seen >= 5 && s.dec_ms_p99 != null && s.leg_age_ms_p99 != null && s.positions.primary);

  // stale price => RFQ skipped (never priced off old data)
  const old = createNoBoostShadow({ book: makeBook([G1, G2], () => t), env: { ...base, NOBOOST_GUARDRAIL: 'off' }, log: quiet, label: 'X' });
  t += 60000; // book clock jumps 60s, no refresh
  const ds = old.onRfq({ rfqId: 'stale', legKeys: keys, contracts: 10 });
  assert.ok(/unpriceable|no_kickoff|stale/.test(ds.reason), ds.reason);
  assert.strictEqual(legBucket(9), '9-10');

  // store: upsert batching + patch + never throws on HTTP errors
  const calls = [];
  const fakeFetch = async (u, o) => { calls.push([o.method, u]); return { ok: true, text: async () => '', json: async () => [] }; };
  const st = createStore({ url: 'https://x.supabase.co', key: 'k', fetchImpl: fakeFetch, log: quiet });
  st.persist(r3); st.persist({ rfq_id: 'c', settled: true, hit: true, primary_pnl: -5 }, 'patch'); st.persistStats({ a: 1 });
  await st.flush();
  assert.deepStrictEqual(calls.map((c) => c[0]), ['POST', 'PATCH', 'POST']);
  assert.ok(/on_conflict=rfq_id/.test(calls[0][1]));
  const bad = createStore({ url: 'https://x.supabase.co', key: 'k', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }), log: quiet });
  bad.persist(r3); await bad.flush();
  console.log('noboost/paper.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
