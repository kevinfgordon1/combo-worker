'use strict';
// COMBO_INTAKE_WORKER: host bounds/stale-drop + switch wiring + a real worker thread smoke.
const assert = require('assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const { createComboIntakeHost, comboIntakeWorkerEnabled, intakeCandidate, mergeReconnects } = require('./combo-intake-host');
const { buildTesterEnv, TESTERS_PERF_DEFAULTS } = require('./tester-env');

assert.strictEqual(comboIntakeWorkerEnabled({}), false, 'default off');
assert.strictEqual(comboIntakeWorkerEnabled({ COMBO_INTAKE_WORKER: '1' }), true);

// Candidate filter: combo only, 15s stale gate.
const now = 1_760_000_000_000;
const bumps = {};
const bump = (k) => { bumps[k] = (bumps[k] || 0) + 1; };
assert.strictEqual(intakeCandidate({ isCombo: false }, { now, bump }), null);
assert.strictEqual(intakeCandidate({ isCombo: true, createdTs: new Date(now - 16000).toISOString() }, { maxAgeMs: 15000, now, bump }), null);
assert.ok(intakeCandidate({ isCombo: true, createdTs: new Date(now - 14000).toISOString() }, { maxAgeMs: 15000, now, bump }));
assert.deepStrictEqual(bumps, { not_combo: 1, stale_at_intake: 1 });

assert.deepStrictEqual(mergeReconnects(mergeReconnects(null, { count: 2, byReason: { a: 2 }, maxGapMs: 5 }), { count: 1, byReason: { a: 1, b: 1 }, maxGapMs: 9 }),
  { count: 3, byReason: { a: 3, b: 1 }, maxGapMs: 9 });

// Host with a fake Worker: bounded inflight, stale drop, plan/open forwarding.
class FakeWorker extends EventEmitter {
  constructor(file, opts) { super(); this.opts = opts; this.sent = []; FakeWorker.last = this; }
  postMessage(m) { this.sent.push(m); }
  async terminate() {}
}
const pending = [];
const seen = [];
const host = createComboIntakeHost({
  env: { COMBO_INTAKE_MAX_INFLIGHT: '8' }, shardFactor: 2, maxAgeMs: 15000, now: () => now,
  WorkerImpl: FakeWorker,
  onRfqCreated: (rfq) => { seen.push(rfq.rfqId); return new Promise((ok) => pending.push(ok)); },
  onRfqDeleted: () => {}, onQuoteAccepted: () => {}, onQuoteExecuted: () => {},
  openIds: () => ['held-1'], syncMs: 10_000,
});
host.setPlan({ needles: ['GBDET'], enabled: true, uncovered: 0 });
host.start();
const w = FakeWorker.last;
assert.deepStrictEqual(w.opts.workerData.plan.needles, ['GBDET'], 'plan reaches the worker at spawn');
assert.strictEqual(w.opts.workerData.shardFactor, 2);
host.setPlan({ needles: ['MIANYJ'], enabled: true, uncovered: 0 });
assert.strictEqual(w.sent.at(-1).t, 'plan');
host.addOpen('rfq-x');
assert.deepStrictEqual(w.sent.at(-1), { t: 'open+', ids: ['rfq-x'] });
const fresh = new Date(now - 1000).toISOString();
for (let i = 0; i < 12; i++) w.emit('message', { t: 'rfq', rfq: { rfqId: `r${i}`, isCombo: true, createdTs: fresh } });
w.emit('message', { t: 'rfq', rfq: { rfqId: 'old', isCombo: true, createdTs: new Date(now - 20000).toISOString() } });
assert.strictEqual(seen.length, 8, 'inflight bound');
let st = host.stats();
assert.strictEqual(st.droppedBusy, 4); assert.strictEqual(st.droppedStale, 1);
(async () => {
  pending.splice(0).forEach((ok) => ok());
  await new Promise((ok) => setImmediate(ok));
  w.emit('message', { t: 'rfq', rfq: { rfqId: 'after', isCombo: true, createdTs: fresh } });
  assert.strictEqual(seen.at(-1), 'after', 'slots free once handlers finish');
  w.emit('message', { t: 'health', h: { shardFactor: 2, shardsUp: 2 } });
  assert.strictEqual(host.health().shardsUp, 2); assert.strictEqual(host.health().intakeWorker, true);
  w.emit('message', { t: 'throughput', snap: { recv: 5 } });
  assert.deepStrictEqual(host.takeThroughput(), { recv: 5 }); assert.strictEqual(host.takeThroughput(), null);
  w.emit('message', { t: 'reconnects', r: { count: 1, byReason: { stall: 1 }, maxGapMs: 3 } });
  assert.strictEqual(host.takeReconnects().count, 1); assert.strictEqual(host.takeReconnects().count, 0);
  await host.stop();

  // Real worker thread loads (noStart: no network) and posts ready.
  const { Worker } = require('worker_threads');
  const real = new Worker(require('path').join(__dirname, 'combo-intake-worker.js'), {
    workerData: { shardFactor: 1, plan: null, maxAgeMs: 15000, dropDeleted: true, noStart: true },
    env: { KALSHI_KEY_ID: 'test', Kalshi_combo_key: require('crypto').generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) },
  });
  const ready = await new Promise((ok) => {
    const t = setTimeout(() => ok(false), 5000);
    real.on('message', (m) => { if (m && m.t === 'ready') { clearTimeout(t); ok(true); } });
    real.on('error', () => { clearTimeout(t); ok(false); });
  });
  await real.terminate();
  assert.ok(ready, 'worker thread starts and posts ready');

  // Wiring: switch-gated in live-runner; testers one-switch defaults.
  const src = fs.readFileSync(require('path').join(__dirname, 'live-runner.js'), 'utf8');
  assert.ok(/const useIntakeWorker = comboIntakeWorkerEnabled\(process\.env\)/.test(src));
  assert.ok(/useIntakeWorker \? createComboIntakeHost\(\{/.test(src));
  assert.ok(/maxAgeMs: STALE_RFQ_MS/.test(src), 'worker uses the same 15s stale rule');
  const off = buildTesterEnv({}, { userId: 'u', kalshi: { keyId: 'k', secret: 's' } });
  for (const k of Object.keys(TESTERS_PERF_DEFAULTS)) assert.strictEqual(off[k], undefined, `${k} not set when TESTERS_PERF off`);
  const onEnv = buildTesterEnv({ TESTERS_PERF: '1', TESTER_ENV_COMBO_INTAKE_WORKER: '0' }, { userId: 'u', kalshi: { keyId: 'k', secret: 's' } });
  assert.strictEqual(onEnv.COMBO_INTAKE_WORKER, '0', 'per-setting override wins');
  assert.strictEqual(onEnv.KALSHI_WS_SHARD_FACTOR, '2');
  assert.strictEqual(onEnv.KALSHI_CLOCK_MIDPOINT, '1');
  assert.strictEqual(onEnv.COMBO_NEAR_MISS_LOG, '1');
  console.log('combo-intake ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
