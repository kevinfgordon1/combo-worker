'use strict';
const assert = require('assert');
const { createDecisionLogger, skipSampleFrom } = require('./index');
const tests = []; const t = (n, f) => tests.push([n, f]);
function fakeDb() { const rows = []; return { rows, supabase: { from: (tb) => ({ insert: async (r) => { assert.strictEqual(tb, 'poly_sniper_decisions'); rows.push(...r); return { error: null }; } }) } }; }

t('skip rows are not inserted; one skip_summary row per reason with count, no legs', async () => {
  const db = fakeDb(); const logs = [];
  const lg = createDecisionLogger({ supabase: db.supabase, log: (m) => logs.push(m), batchMs: 1e9, summaryMs: 1e9 });
  for (let i = 0; i < 300; i += 1) lg.push({ action: 'skip', reason: 'unmapped_leg', legs: [{ x: 1 }] });
  for (let i = 0; i < 50; i += 1) lg.push({ action: 'skip', reason: 'scope_nba' });
  lg.push({ action: 'quote', rfq_id: 'q1' });
  await lg.flush();
  assert.deepStrictEqual(db.rows.map((r) => r.action), ['quote']);
  assert.strictEqual(lg.summarize(), 2);
  await lg.flush();
  const sums = db.rows.filter((r) => r.action === 'skip_summary');
  assert.strictEqual(sums.length, 2);
  assert.strictEqual(sums.find((r) => r.reason === 'unmapped_leg').contracts, 300);
  assert.strictEqual(sums.find((r) => r.reason === 'scope_nba').contracts, 50);
  assert.ok(sums.every((r) => r.legs == null && r.rfq_id && r.venue === 'polymarket'));
  assert.ok(logs.some((m) => /skip summary .*total=350 unmapped_leg=300 scope_nba=50/.test(m)));
  assert.strictEqual(lg.summarize(), 0, 'counters reset after each window');
});

t('SNIPER_SKIP_SAMPLE keeps a sampled fraction of full skip rows', async () => {
  const db = fakeDb(); let i = 0;
  const lg = createDecisionLogger({ supabase: db.supabase, log: () => {}, batchMs: 1e9, summaryMs: 1e9, skipSample: 0.1, random: () => ((i++ % 10) / 10) });
  for (let k = 0; k < 100; k += 1) lg.push({ action: 'skip', reason: 'total_cap' });
  await lg.flush();
  assert.strictEqual(db.rows.filter((r) => r.action === 'skip').length, 10);
  assert.strictEqual(skipSampleFrom({}), 0);
  assert.strictEqual(skipSampleFrom({ SNIPER_SKIP_SAMPLE: '0.01' }), 0.01);
  assert.strictEqual(skipSampleFrom({ POLY_SNIPER_SKIP_SAMPLE: '5' }), 1);
  assert.strictEqual(skipSampleFrom({ SNIPER_SKIP_SAMPLE: 'x' }), 0);
});

t('POLY_SNIPER_LOG_SKIPS=0 still logs the summary line but writes no summary rows', async () => {
  const db = fakeDb(); const logs = [];
  const lg = createDecisionLogger({ supabase: db.supabase, log: (m) => logs.push(m), batchMs: 1e9, summaryMs: 1e9, logSkips: false });
  lg.push({ action: 'skip', reason: 'prices_stale' }); lg.summarize(); await lg.flush();
  assert.strictEqual(db.rows.length, 0);
  assert.ok(logs.some((m) => /prices_stale=1/.test(m)));
});

(async () => { for (const [n, f] of tests) { await f(); console.log(`ok ${n}`); } console.log(`skip-summary: ${tests.length} tests passed`); })().catch((e) => { console.error(e); process.exit(1); });
