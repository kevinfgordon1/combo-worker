'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  WORKER_MODE_COMBO,
  WORKER_MODE_UNHEDGED,
  WORKER_MODE_ALL,
  resolveWorkerMode,
  shouldRunComboLocks,
  shouldRunUnhedged,
} = require('./worker-mode');

assert.strictEqual(resolveWorkerMode({}), WORKER_MODE_COMBO);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: '' }), WORKER_MODE_COMBO);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'combo' }), WORKER_MODE_COMBO);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'LIVE' }), WORKER_MODE_COMBO);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'unhedged' }), WORKER_MODE_UNHEDGED);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'UNHEDGED_RFQ' }), WORKER_MODE_UNHEDGED);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'all' }), WORKER_MODE_ALL);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'both' }), WORKER_MODE_ALL);
assert.strictEqual(resolveWorkerMode({ WORKER_MODE: 'mystery' }), WORKER_MODE_COMBO);

assert.strictEqual(shouldRunComboLocks({}), true);
assert.strictEqual(shouldRunUnhedged({}), false);
assert.strictEqual(shouldRunComboLocks({ WORKER_MODE: 'combo' }), true);
assert.strictEqual(shouldRunUnhedged({ WORKER_MODE: 'combo' }), false);
assert.strictEqual(shouldRunComboLocks({ WORKER_MODE: 'unhedged' }), false);
assert.strictEqual(shouldRunUnhedged({ WORKER_MODE: 'unhedged' }), true);
assert.strictEqual(shouldRunComboLocks({ WORKER_MODE: 'all' }), true);
assert.strictEqual(shouldRunUnhedged({ WORKER_MODE: 'all' }), true);

{
  const startLive = fs.readFileSync(path.join(__dirname, 'start-live.js'), 'utf8');
  const startUnhedged = fs.readFileSync(path.join(__dirname, 'start-unhedged.js'), 'utf8');
  const startAll = fs.readFileSync(path.join(__dirname, 'start-all.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

  assert.ok(startLive.includes("run('live-runner.js')"));
  assert.ok(startLive.includes("run('fills-reader.js')"));
  assert.ok(!startLive.includes('unhedged-runner'));
  assert.ok(/WORKER_MODE=unhedged/.test(startLive), 'start-live must refuse the Unhedged mode');

  assert.ok(startUnhedged.includes("require('./unhedged-runner')"));
  assert.ok(!startUnhedged.includes("require('./live-runner')"));
  assert.ok(!startUnhedged.includes("require('./fills-reader')"));
  assert.ok(!/run\(['"]fills-reader/.test(startUnhedged));
  assert.ok(startUnhedged.includes('WORKER_MODE_UNHEDGED'));

  assert.ok(startAll.includes("WORKER_MODE") && startAll.includes('all'));
  assert.ok(startAll.includes("require('./start-live')"));

  assert.strictEqual(pkg.scripts.start, 'node start-live.js');
  assert.strictEqual(pkg.scripts['start:combo'], 'node start-live.js');
  assert.strictEqual(pkg.scripts['start:unhedged'], 'node start-unhedged.js');
  assert.strictEqual(pkg.scripts['start:all'], 'node start-all.js');
}

{
  const unhedgedSrc = fs.readFileSync(path.join(__dirname, 'unhedged-runner.js'), 'utf8');
  assert.ok(!/require\('\.\/quote-watcher'\)/.test(unhedgedSrc), 'quote-watcher stays parked');
  assert.ok(!/kalshiQuoteHttp/.test(unhedgedSrc), 'Unhedged job must not own the Combo Lock quote HTTP pool');
  assert.ok(!/createKalshiRestPair/.test(unhedgedSrc), 'Unhedged job uses its own REST client, not the quote pair');
  assert.ok(/enableLocks:\s*false/.test(unhedgedSrc));
  assert.ok(/enableUnhedged:\s*true/.test(unhedgedSrc));
  assert.ok(/paper-only/.test(unhedgedSrc) || /paper \/ shadow only/.test(unhedgedSrc));
  assert.ok(/UNHEDGED_RFQ_LIVE/.test(unhedgedSrc));
  assert.ok(/createKalshiWs/.test(unhedgedSrc), 'Unhedged job has its own Kalshi WS');
  assert.ok(/startUnhedgedSide/.test(unhedgedSrc));
  assert.ok(/handleKalshiUnhedgedCreated/.test(unhedgedSrc));
  assert.ok(/applyRefreshParlays/.test(unhedgedSrc), 'lock-skip snapshot must soft-fail retain parlays');
}

console.log('worker-mode.test.js ok');
